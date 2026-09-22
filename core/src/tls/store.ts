import { X509Certificate } from 'node:crypto';
import type { Context } from '../context';
import { BastionError } from '../errors';
import type { TlsMaterial } from '../front/listener';

export interface StoredCertificate {
	hosts: string[];
	certificatePem: string;
	privateKeyPem: string;
	issuedAt: number;
	expiresAt: number;
	/** `acme`, `imported` or `local`, so a renewal never touches a chain an operator installed */
	source: 'acme' | 'imported' | 'local';
}

/** warn at 21 days, error at 7, critical at 2 */
export const EXPIRY_LADDER = { warn: 21, error: 7, critical: 2 } as const;

export type ExpirySeverity = 'ok' | 'warn' | 'error' | 'critical' | 'expired';

export function expirySeverity(certificate: StoredCertificate, now: number): ExpirySeverity {
	const days = (certificate.expiresAt - now) / 86_400_000;
	if (days <= 0) return 'expired';
	if (days <= EXPIRY_LADDER.critical) return 'critical';
	if (days <= EXPIRY_LADDER.error) return 'error';
	if (days <= EXPIRY_LADDER.warn) return 'warn';
	return 'ok';
}

/**
 * Reads `notAfter` out of a PEM chain's leaf.
 *
 * Node parses the certificate, so this is the certificate's own answer rather than an assumption
 * that every CA issues for ninety days. An operator's institutional CA commonly issues for one
 * year, and a renewal loop hard-coded to ninety days would renew it eleven months early, every
 * time, against a CA with a rate limit.
 */
export function expiryOf(certificatePem: string): number {
	const [leaf] = certificatePem.split('-----END CERTIFICATE-----');
	const block = `${leaf}-----END CERTIFICATE-----`;
	try {
		return Date.parse(new X509Certificate(block).validTo);
	} catch {
		throw new BastionError('usage', 'that does not parse as a PEM certificate');
	}
}

export function hostsOf(certificatePem: string): string[] {
	const [leaf] = certificatePem.split('-----END CERTIFICATE-----');
	const block = `${leaf}-----END CERTIFICATE-----`;
	const names = new X509Certificate(block).subjectAltName ?? '';
	return names
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.startsWith('DNS:'))
		.map((entry) => entry.slice(4));
}

/**
 * Certificates on disk, one directory per host.
 *
 * The private key is written at 0600 before the certificate, and the pair is only advertised to
 * the listener once both are there -- a half-written pair binds a listener with a key that does
 * not match its chain, and every client sees a handshake failure rather than an error anyone can
 * read.
 */
export class CertificateStore {
	private readonly ctx: Context;
	private readonly root: string;

	constructor(ctx: Context, root: string) {
		this.ctx = ctx;
		this.root = root;
	}

	private dir(host: string): string {
		if (host.includes('/') || host.includes('..')) {
			throw new BastionError('usage', `${JSON.stringify(host)} is not a hostname`);
		}
		return `${this.root}/${host}`;
	}

	save(host: string, certificate: StoredCertificate): void {
		const dir = this.dir(host);
		this.ctx.files.mkdirp(dir);
		this.ctx.files.writeText(`${dir}/key.pem`, certificate.privateKeyPem);
		this.ctx.files.chmod(`${dir}/key.pem`, 0o600);
		this.ctx.files.writeText(`${dir}/fullchain.pem`, certificate.certificatePem);
		this.ctx.files.writeText(
			`${dir}/meta.json`,
			JSON.stringify({
				hosts: certificate.hosts,
				issuedAt: certificate.issuedAt,
				expiresAt: certificate.expiresAt,
				source: certificate.source
			})
		);
	}

	load(host: string): StoredCertificate | null {
		const dir = this.dir(host);
		if (!this.ctx.files.exists(`${dir}/meta.json`)) return null;
		if (!this.ctx.files.exists(`${dir}/key.pem`)) return null;
		if (!this.ctx.files.exists(`${dir}/fullchain.pem`)) return null;
		const meta = JSON.parse(this.ctx.files.readText(`${dir}/meta.json`)) as {
			hosts: string[];
			issuedAt: number;
			expiresAt: number;
			source: StoredCertificate['source'];
		};
		return {
			...meta,
			privateKeyPem: this.ctx.files.readText(`${dir}/key.pem`),
			certificatePem: this.ctx.files.readText(`${dir}/fullchain.pem`)
		};
	}

	list(): string[] {
		if (!this.ctx.files.exists(this.root)) return [];
		return this.ctx.files
			.readDir(this.root)
			.filter((entry) => entry.directory)
			.map((entry) => entry.name)
			.sort();
	}

	/** the SNI table the listener is bound with; a host with no usable pair is simply absent */
	material(): TlsMaterial[] {
		const out: TlsMaterial[] = [];
		for (const host of this.list()) {
			const certificate = this.load(host);
			if (certificate === null) continue;
			out.push({
				serverName: host,
				key: certificate.privateKeyPem,
				cert: certificate.certificatePem
			});
		}
		return out;
	}

	/** hosts needing a renewal now, which is every host at `warn` or worse */
	due(now: number): { host: string; severity: ExpirySeverity }[] {
		const out: { host: string; severity: ExpirySeverity }[] = [];
		for (const host of this.list()) {
			const certificate = this.load(host);
			if (certificate === null) continue;
			const severity = expirySeverity(certificate, now);
			if (severity !== 'ok') out.push({ host, severity });
		}
		return out;
	}
}
