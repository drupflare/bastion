import { X509Certificate, createPrivateKey } from 'node:crypto';
import { BastionError } from '../errors';

export interface ChainProblem {
	id: string;
	detail: string;
	/** false where an operator may reasonably proceed anyway */
	fatal: boolean;
}

export interface ChainReport {
	ok: boolean;
	problems: ChainProblem[];
	hosts: string[];
	notAfter: number;
	notBefore: number;
	issuer: string;
	subject: string;
	/** how many certificates were in the file, leaf first */
	length: number;
	selfSigned: boolean;
}

export function splitChain(pem: string): string[] {
	const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
	return blocks ?? [];
}

/**
 * Checks a certificate chain before it is installed.
 *
 * The store used to write whatever it was handed, which meant every one of these failed later and
 * somewhere unhelpful: a mismatched key is a handshake error with no server-side message, an
 * out-of-order chain is an intermittent failure depending on what the client already cached, and a
 * chain missing its intermediate works in a browser that has seen it before and fails for everyone
 * else. Each check here turns one of those into a sentence at import time.
 *
 * `hosts` is the set the site must serve. A certificate that covers more is fine; one that covers
 * less is refused, because the names it misses are the ones that will fail.
 */
export function checkChain(
	certificatePem: string,
	privateKeyPem: string | null,
	hosts: string[],
	now: number
): ChainReport {
	const problems: ChainProblem[] = [];
	const blocks = splitChain(certificatePem);

	if (blocks.length === 0) {
		throw new BastionError('usage', 'that file contains no PEM certificate');
	}

	let parsed: X509Certificate[];
	try {
		parsed = blocks.map((block) => new X509Certificate(block));
	} catch (e) {
		throw new BastionError(
			'usage',
			`a certificate in that file did not parse: ${e instanceof Error ? e.message : String(e)}`
		);
	}

	const leaf = parsed[0] as X509Certificate;
	const covered = (leaf.subjectAltName ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.startsWith('DNS:'))
		.map((entry) => entry.slice(4).toLowerCase());

	if (privateKeyPem !== null) {
		let matches = false;
		try {
			matches = leaf.checkPrivateKey(createPrivateKey(privateKeyPem));
		} catch {
			matches = false;
		}
		if (!matches) {
			problems.push({
				id: 'key',
				fatal: true,
				detail:
					'the private key does not match the leaf certificate. A listener bound with this ' +
					'pair fails every handshake with nothing in its own log'
			});
		}
	}

	const notBefore = Date.parse(leaf.validFrom);
	const notAfter = Date.parse(leaf.validTo);
	if (notAfter <= now) {
		problems.push({
			id: 'expired',
			fatal: true,
			detail: `the leaf expired on ${leaf.validTo}`
		});
	} else if (notBefore > now) {
		problems.push({
			id: 'not-yet-valid',
			fatal: true,
			detail: `the leaf is not valid until ${leaf.validFrom}; check this host's clock`
		});
	}

	const missing = hosts
		.map((host) => host.toLowerCase())
		.filter((host) => leaf.checkHost(host) === undefined);
	if (missing.length > 0) {
		problems.push({
			id: 'hosts',
			fatal: true,
			detail:
				`the certificate does not cover ${missing.join(', ')}. It covers ` +
				`${covered.join(', ') || '(no DNS names)'}`
		});
	}

	// each certificate must be issued by the next one, leaf first. An out-of-order file is the
	// single most common way an institutional chain arrives
	for (let i = 0; i < parsed.length - 1; i++) {
		const child = parsed[i] as X509Certificate;
		const parent = parsed[i + 1] as X509Certificate;
		if (!child.verify(parent.publicKey)) {
			problems.push({
				id: 'chain-order',
				fatal: true,
				detail:
					`certificate ${i + 1} is not signed by certificate ${i + 2}. A chain file is ` +
					'ordered leaf first, then each issuer in turn'
			});
			break;
		}
	}

	const last = parsed[parsed.length - 1] as X509Certificate;
	const selfSigned = last.verify(last.publicKey);
	if (parsed.length === 1 && !selfSigned) {
		problems.push({
			id: 'incomplete',
			fatal: false,
			detail:
				'only the leaf is present. Clients that have not already cached the intermediate will ' +
				'reject it; append the issuer chain'
		});
	}

	return {
		ok: problems.every((problem) => !problem.fatal),
		problems,
		hosts: covered,
		notBefore,
		notAfter,
		issuer: leaf.issuer.replace(/\n/g, ', '),
		subject: leaf.subject.replace(/\n/g, ', '),
		length: parsed.length,
		selfSigned
	};
}

export function assertChain(report: ChainReport, host: string): void {
	if (report.ok) return;
	throw new BastionError(
		'usage',
		[
			`that certificate cannot be installed for ${host}:`,
			...report.problems.filter((p) => p.fatal).map((p) => `  ${p.id}: ${p.detail}`)
		].join('\n'),
		{ next: `bastion cert list` }
	);
}
