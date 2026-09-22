import type { Context } from '../context';
import type { DnsResolver } from '../domains/dns';
import {
	dnsResponder,
	manualDnsResponder,
	txtWatcher,
	type DnsProvider,
	type DnsRecord
} from '../domains/provider';
import { BastionError } from '../errors';
import type { ListenerHost } from '../front/listener';
import {
	ACME_CHALLENGE_PREFIX,
	AcmeClient,
	httpResponder,
	type ChallengeResponder,
	type IssuedCertificate
} from './acme';
import type { Strategy } from './issue';
import { CertificateStore, type StoredCertificate } from './store';
import { checkChain } from './verify';

export interface OrderOptions {
	hosts: string[];
	strategy: Strategy;
	email: string;
	directory?: string;
	ca?: string;
	accountKeyPem?: string;
	/** for `acme-dns-01`; absent means the manual path */
	provider?: DnsProvider | null;
	/** for `acme-dns-01-manual`, so an operator can watch the record appear */
	resolver?: DnsResolver | null;
	/** for `acme-http-01` when bastion is not already serving on port 80 */
	listenerHost?: ListenerHost | null;
	httpAddress?: string;
	/** where a manual record is printed */
	announce?(record: DnsRecord): void;
	sleep?(ms: number): Promise<void>;
	/** attempts for the manual watcher; short in a test, long in a real run */
	watchAttempts?: number;
}

export interface OrderResult {
	certificate: IssuedCertificate;
	strategy: Strategy;
	/** what had to be done by hand, so a report says whether this can be scheduled */
	manual: boolean;
}

/**
 * Builds the challenge responder a strategy needs, and says what it costs.
 *
 * The three ACME strategies differ only here. Choosing the responder in one place is what keeps
 * `issue` from growing a branch per strategy, and it is also where the manual path is marked as
 * manual, which is what stops a renewal loop scheduling something that needs a human.
 */
export function responderFor(
	ctx: Context,
	options: OrderOptions
): { responder: ChallengeResponder; manual: boolean; teardown(): Promise<void> } {
	if (options.strategy === 'acme-dns-01') {
		if (options.provider == null) {
			throw new BastionError(
				'usage',
				'the dns-01 strategy needs a provider; configure `domains.provider` or use the manual path'
			);
		}
		const wait = options.sleep;
		return {
			responder: dnsResponder(options.provider, wait === undefined ? {} : { sleep: wait }),
			manual: false,
			teardown: async () => {}
		};
	}

	if (options.strategy === 'acme-dns-01-manual') {
		const resolver = options.resolver;
		const announce =
			options.announce ??
			((record: DnsRecord) => {
				ctx.io.out(`publish this record, then leave it in place until issuance finishes:`);
				ctx.io.out(`  TXT ${record.name} "${record.value}"`);
			});
		return {
			responder: manualDnsResponder({
				announce,
				confirm:
					resolver == null
						? async () => true
						: txtWatcher((name) => resolver.txt(name), {
								attempts: options.watchAttempts ?? 60,
								...(options.sleep === undefined ? {} : { sleep: options.sleep })
							})
			}),
			manual: true,
			teardown: async () => {}
		};
	}

	if (options.strategy === 'acme-http-01') {
		const responder = httpResponder();
		const host = options.listenerHost;
		if (host == null) {
			// no listener to bind means bastion is already serving; the running front door answers
			// the challenge from the same responder, so there is nothing to bind here
			return { responder, manual: false, teardown: async () => {} };
		}
		const listener = host.listen(
			{ address: options.httpAddress ?? '0.0.0.0:80', reusePort: true },
			async (request) => {
				const url = new URL(request.url);
				if (!url.pathname.startsWith(ACME_CHALLENGE_PREFIX)) {
					return new Response('not found', { status: 404 });
				}
				const answer = responder.answer(url.pathname.slice(ACME_CHALLENGE_PREFIX.length));
				return answer === null
					? new Response('not found', { status: 404 })
					: new Response(answer, { headers: { 'content-type': 'text/plain' } });
			}
		);
		return {
			responder,
			manual: false,
			teardown: async () => {
				await listener.stop(false);
			}
		};
	}

	throw new BastionError('usage', `${options.strategy} is not an ACME strategy`);
}

/**
 * Runs one ACME order and returns the certificate.
 *
 * The teardown runs in a `finally`, so a standalone listener bound for a challenge is released
 * whether the order succeeded or not. A port left bound after a failed issuance is the thing that
 * makes the second attempt fail for a different reason than the first.
 */
export async function runOrder(ctx: Context, options: OrderOptions): Promise<OrderResult> {
	const { responder, manual, teardown } = responderFor(ctx, options);
	const client = new AcmeClient(ctx, {
		email: options.email,
		...(options.directory === undefined ? {} : { directory: options.directory }),
		...(options.ca === undefined ? {} : { ca: options.ca }),
		...(options.accountKeyPem === undefined ? {} : { accountKeyPem: options.accountKeyPem }),
		...(options.sleep === undefined ? {} : { sleep: options.sleep })
	});
	try {
		const certificate = await client.issue(options.hosts, responder);
		return { certificate, strategy: options.strategy, manual };
	} finally {
		await teardown().catch(() => {});
	}
}

/**
 * Issues and stores, checking the result before it is installed.
 *
 * The CA's answer is verified the same way an operator's import is. A CA that returned a chain
 * covering the wrong names, or one whose leaf does not match the key just generated, would
 * otherwise be discovered by a client during a handshake rather than here.
 */
export async function issueAndStore(
	ctx: Context,
	store: CertificateStore,
	options: OrderOptions
): Promise<{ result: OrderResult; stored: StoredCertificate }> {
	const result = await runOrder(ctx, options);
	const report = checkChain(
		result.certificate.certificatePem,
		result.certificate.privateKeyPem,
		options.hosts,
		ctx.now()
	);
	if (!report.ok) {
		throw new BastionError(
			'driver-refused',
			[
				`the CA returned a certificate bastion will not install for ${options.hosts[0]}:`,
				...report.problems
					.filter((problem) => problem.fatal)
					.map((p) => `  ${p.id}: ${p.detail}`)
			].join('\n')
		);
	}
	const stored: StoredCertificate = {
		hosts: report.hosts,
		certificatePem: result.certificate.certificatePem,
		privateKeyPem: result.certificate.privateKeyPem,
		issuedAt: report.notBefore,
		expiresAt: report.notAfter,
		source: 'acme'
	};
	store.save(options.hosts[0] as string, stored);
	return { result, stored };
}
