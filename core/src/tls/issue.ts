import type { BastionConfig } from '../config/types';
import { isUnderPrimary, type PrimaryDomain } from '../domains/naming';
import type { DnsProvider } from '../domains/provider';
import { BastionError } from '../errors';
import type { StoredCertificate } from './store';

export type Strategy =
	'acme-http-01' | 'acme-dns-01' | 'acme-dns-01-manual' | 'imported' | 'local-ca' | 'self-signed';

export interface StrategyChoice {
	strategy: Strategy;
	/** why this one, in the words a `--dry-run` prints */
	reason: string;
	/** true when the operator has to do something before issuance can finish */
	needsOperator: boolean;
	/** what they have to do, when they do */
	instruction: string | null;
}

export interface StrategyInput {
	host: string;
	/** true for a name covering `*.something`, which only DNS-01 can answer */
	wildcard?: boolean;
	provider?: DnsProvider | null;
	primary?: PrimaryDomain | null;
	acmeConfigured: boolean;
	/** a chain an operator already installed, which is never replaced automatically */
	existing?: StoredCertificate | null;
	localCaAvailable?: boolean;
	/** false where the name cannot be resolved from the public internet */
	publiclyReachable?: boolean;
}

const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.test', '.example', '.invalid'];

export function isLocalName(host: string): boolean {
	const name = host.toLowerCase().replace(/\.$/, '');
	return LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix)) || !name.includes('.');
}

/**
 * Which issuance path a name gets.
 *
 * The order is not preference, it is what can actually work. An imported chain wins outright
 * because replacing an institution's own certificate with one from a public CA is a decision
 * bastion must never make quietly. A wildcard or an unreachable name cannot use HTTP-01 at all. A
 * `.local` name cannot use a public CA at all, because no public CA will issue for a name it
 * cannot validate.
 *
 * Every branch that cannot complete on its own says so and says what the operator does, rather
 * than starting an order that will time out in the CA with an error nobody sees.
 */
export function chooseStrategy(input: StrategyInput): StrategyChoice {
	if (input.existing != null && input.existing.source === 'imported') {
		return {
			strategy: 'imported',
			reason: 'an operator installed this chain, and bastion never replaces one it did not issue',
			needsOperator: false,
			instruction: null
		};
	}

	if (isLocalName(input.host)) {
		if (input.localCaAvailable === true) {
			return {
				strategy: 'local-ca',
				reason: `${input.host} is a local name, so it is signed by the local CA`,
				needsOperator: false,
				instruction: null
			};
		}
		return {
			strategy: 'self-signed',
			reason:
				`${input.host} is a local name and no public CA will issue for it, and no local CA ` +
				'is configured',
			needsOperator: true,
			instruction: `bastion cert trust <ca.pem> on every client, or accept the warning`
		};
	}

	if (!input.acmeConfigured) {
		return {
			strategy: 'self-signed',
			reason: 'no ACME account is configured',
			needsOperator: true,
			instruction: 'set `tls.acme.email`, or import a chain with `bastion cert import`'
		};
	}

	const wildcard = input.wildcard === true || input.host.startsWith('*.');
	if (wildcard) {
		if (input.provider != null) {
			return {
				strategy: 'acme-dns-01',
				reason: `a wildcard needs DNS-01, and ${input.provider.id()} hosts this zone`,
				needsOperator: false,
				instruction: null
			};
		}
		return {
			strategy: 'acme-dns-01-manual',
			reason: 'a wildcard needs DNS-01 and no DNS provider is configured',
			needsOperator: true,
			instruction: `bastion cert issue ${input.host} prints the TXT record to publish, then waits`
		};
	}

	if (input.publiclyReachable === false) {
		return {
			strategy: input.provider != null ? 'acme-dns-01' : 'acme-dns-01-manual',
			reason:
				`${input.host} is not reachable over HTTP from the internet, so an HTTP challenge ` +
				'cannot be answered',
			needsOperator: input.provider == null,
			instruction:
				input.provider == null
					? 'publish the TXT record bastion prints, or configure a DNS provider'
					: null
		};
	}

	if (
		input.primary != null &&
		isUnderPrimary(input.host, input.primary) &&
		input.provider != null
	) {
		return {
			strategy: 'acme-dns-01',
			reason:
				'this name is under the primary domain and a DNS provider hosts it, so no HTTP ' +
				'challenge has to reach this node',
			needsOperator: false,
			instruction: null
		};
	}

	return {
		strategy: 'acme-http-01',
		reason: 'the name resolves to this node and the front door answers the challenge',
		needsOperator: false,
		instruction: null
	};
}

/** whether a stored certificate may be renewed automatically, and why not when it may not */
export function renewable(certificate: StoredCertificate): { ok: boolean; reason: string } {
	if (certificate.source === 'imported') {
		return {
			ok: false,
			reason:
				'this chain was imported. bastion will not replace it with one from a public CA; ' +
				'renew it with your own CA and run `bastion cert import` again'
		};
	}
	if (certificate.source === 'local') {
		// a self-signed leaf is bastion's own and can be made again. A leaf signed by a local CA
		// cannot, because that CA's key deliberately does not live on this host; `local.ts` refuses
		// to hold one. These two used to be one answer, and the renewal loop would have believed
		// whichever it read
		const blocks = certificate.certificatePem.match(/BEGIN CERTIFICATE/g)?.length ?? 1;
		if (blocks > 1) {
			return {
				ok: false,
				reason:
					'this leaf was signed by a local CA whose key does not live on this host. ' +
					'Re-sign it where the CA key is and run `bastion cert import`'
			};
		}
		return { ok: true, reason: 'self-signed by bastion, which can sign it again' };
	}
	return { ok: true, reason: 'issued over ACME, which bastion renews' };
}

export function acmeConfigured(config: BastionConfig): boolean {
	const acme = (config.tls as { acme?: { email?: string } } | undefined)?.acme;
	return typeof acme?.email === 'string' && acme.email.includes('@');
}

export function assertIssuable(choice: StrategyChoice): void {
	if (!choice.needsOperator) return;
	throw new BastionError(
		'capability-refused',
		`${choice.reason}. ${choice.instruction ?? ''}`.trim(),
		{
			next: choice.instruction ?? null
		}
	);
}
