import { createHmac } from 'node:crypto';
import type { DnsResolver } from './dns';

export const CHALLENGE_PREFIX = '_bastion-challenge';

/**
 * The TXT value a domain must publish to prove it belongs to the tenant claiming it.
 *
 * Derived from an install secret and the pair of names rather than random, so it survives a
 * restart and an operator can print it again without invalidating what the tenant already
 * published. Keyed on the TENANT as well as the host, so one tenant cannot pre-publish a token
 * that would later validate another tenant's claim on the same name.
 */
export function challengeToken(secret: string, tenant: string, host: string): string {
	return createHmac('sha256', secret)
		.update(`${tenant}\n${host.toLowerCase()}`)
		.digest('base64url')
		.slice(0, 43);
}

export function challengeName(host: string): string {
	return `${CHALLENGE_PREFIX}.${host.toLowerCase()}`;
}

export type CheckState = 'pass' | 'fail' | 'unknown';

export interface Check {
	id: string;
	state: CheckState;
	/** what an operator should read; a failure says what to do, not only what is wrong */
	detail: string;
}

export interface DomainReport {
	host: string;
	tenant: string;
	ready: boolean;
	checks: Check[];
	/** the exact record to publish, so the answer is copy-and-pasteable */
	instructions: string[];
}

export interface VerifyOptions {
	/** the addresses this node answers on, so a DNS check can say whether the name reaches here */
	addresses: string[];
	/** the ACME CA that will be asked to issue, for the CAA comparison */
	caaIdentity?: string;
	/** skipped for a name under the primary domain, which bastion already controls */
	requireOwnership?: boolean;
}

/**
 * Everything that has to be true before a certificate can be issued for a name.
 *
 * Each check exists because its absence produces an error somewhere else that says nothing useful.
 * An unverified domain is a tenant claiming a name it may not own. A domain whose DNS does not
 * point here gets an ACME challenge that times out with no explanation. And a CAA record that does
 * not name the configured CA makes issuance fail inside the CA with a message the operator never
 * sees, which is the single most opaque failure in this whole path.
 */
export async function checkDomain(
	dns: DnsResolver,
	secret: string,
	tenant: string,
	host: string,
	options: VerifyOptions
): Promise<DomainReport> {
	const checks: Check[] = [];
	const instructions: string[] = [];
	const name = host.toLowerCase();
	const expected = challengeToken(secret, tenant, name);

	if (options.requireOwnership !== false) {
		const published = await dns.txt(challengeName(name)).catch(() => null);
		if (published === null) {
			checks.push({
				id: 'ownership',
				state: 'unknown',
				detail: 'the resolver could not be reached, so ownership could not be checked'
			});
		} else if (published.includes(expected)) {
			checks.push({ id: 'ownership', state: 'pass', detail: 'the challenge record matches' });
		} else {
			checks.push({
				id: 'ownership',
				state: 'fail',
				detail:
					published.length === 0
						? `no TXT record at ${challengeName(name)}`
						: `the TXT record at ${challengeName(name)} does not match this tenant`
			});
			instructions.push(`TXT ${challengeName(name)} "${expected}"`);
		}
	}

	const [a, aaaa, cname] = await Promise.all([
		dns.a(name).catch(() => []),
		dns.aaaa(name).catch(() => []),
		dns.cname(name).catch(() => [])
	]);
	const pointing = [...a, ...aaaa];
	if (pointing.length === 0 && cname.length === 0) {
		checks.push({
			id: 'dns',
			state: 'fail',
			detail: `${name} resolves to nothing, so an HTTP challenge cannot reach this node`
		});
		for (const address of options.addresses) {
			instructions.push(`${address.includes(':') ? 'AAAA' : 'A'} ${name} ${address}`);
		}
	} else if (options.addresses.length === 0) {
		checks.push({
			id: 'dns',
			state: 'unknown',
			detail: 'this node has no configured public address to compare against'
		});
	} else if (pointing.some((address) => options.addresses.includes(address))) {
		checks.push({ id: 'dns', state: 'pass', detail: `${name} points at this node` });
	} else if (cname.length > 0) {
		checks.push({
			id: 'dns',
			state: 'unknown',
			detail: `${name} is a CNAME to ${cname.join(', ')}; it may still reach this node`
		});
	} else {
		checks.push({
			id: 'dns',
			state: 'fail',
			detail:
				`${name} points at ${pointing.join(', ')} and this node answers on ` +
				`${options.addresses.join(', ')}`
		});
	}

	const identity = options.caaIdentity;
	if (identity !== undefined) {
		const caa = await dns.caa(name).catch(() => null);
		if (caa === null) {
			checks.push({ id: 'caa', state: 'unknown', detail: 'CAA could not be read' });
		} else {
			const issuers = caa.filter((record) => record.tag === 'issue').map((r) => r.value);
			if (issuers.length === 0) {
				checks.push({
					id: 'caa',
					state: 'pass',
					detail: 'no CAA record, so any CA may issue'
				});
			} else if (issuers.some((value) => value.split(';')[0]?.trim() === identity)) {
				checks.push({ id: 'caa', state: 'pass', detail: `CAA permits ${identity}` });
			} else {
				checks.push({
					id: 'caa',
					state: 'fail',
					detail:
						`CAA permits ${issuers.join(', ')} and bastion is configured to use ` +
						`${identity}, so issuance would be refused by the CA`
				});
				instructions.push(`CAA ${name} 0 issue "${identity}"`);
			}
		}
	}

	return {
		host: name,
		tenant,
		ready: checks.every((check) => check.state === 'pass'),
		checks,
		instructions
	};
}
