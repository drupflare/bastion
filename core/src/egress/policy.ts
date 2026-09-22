import type { TenantConfig } from '../config/types';
import type { Context } from '../context';
import { BastionError } from '../errors';

export interface EgressRule {
	host: string;
	port: number;
}

/** bastion's own nftables table, so it never edits the operator's */
export const TABLE = 'bastion';

/**
 * Addresses a tenant must never reach, whatever its allow list says.
 *
 * A Worker's `fetch` egresses from the operator's LAN, so the default posture on a self-hosted box
 * is SSRF into the internal network. These four ranges are the ones that turn one compromised site
 * into the whole estate: cloud metadata at 169.254.169.254 hands out instance credentials, loopback
 * reaches bastion's own management listener, and the private ranges are every other tenant's admin
 * port and the hypervisor's management interface.
 */
export const NEVER_REACHABLE = [
	'127.0.0.0/8',
	'169.254.0.0/16',
	'10.0.0.0/8',
	'172.16.0.0/12',
	'192.168.0.0/16',
	'::1/128',
	'fc00::/7',
	'fe80::/10'
] as const;

export function parseRule(entry: string): EgressRule {
	const at = entry.lastIndexOf(':');
	if (at === -1) throw new BastionError('config-invalid', `${entry} needs a host and a port`);
	const host = entry.slice(0, at);
	const port = Number(entry.slice(at + 1));
	if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new BastionError('config-invalid', `${entry} is not host:port`);
	}
	return { host, port };
}

export function rulesFor(tenant: TenantConfig): EgressRule[] {
	return (tenant.egress?.allow ?? []).map(parseRule);
}

/**
 * The nftables program for one tenant.
 *
 * Deny by default, then the tenant's allow list, and the never-reachable set is dropped BEFORE the
 * allow list is consulted -- so an allow entry that resolves into a private range cannot open one.
 * That ordering is the whole rule: an operator writing `updates.internal:443` should get a refusal
 * rather than a hole into their own network.
 */
export function nftablesProgram(tenant: string, rules: EgressRule[]): string {
	const chain = `egress_${tenant.replace(/[^a-zA-Z0-9_]/g, '_')}`;
	const lines = [
		`table inet ${TABLE} {`,
		`\tchain ${chain} {`,
		'\t\ttype filter hook output priority 0; policy drop;',
		'\t\tct state established,related accept',
		...NEVER_REACHABLE.map((cidr) =>
			cidr.includes(':') ? `\t\tip6 daddr ${cidr} drop` : `\t\tip daddr ${cidr} drop`
		),
		...rules.map((rule) => `\t\tip daddr ${rule.host} tcp dport ${rule.port} accept`),
		'\t\tudp dport 53 accept',
		'\t}',
		'}',
		''
	];
	return lines.join('\n');
}

export async function applyPolicy(
	ctx: Context,
	tenant: string,
	rules: EgressRule[]
): Promise<string> {
	const program = nftablesProgram(tenant, rules);
	await ctx.runner.run('nft', ['-f', '-'], { input: program });
	return program;
}

export interface DriftReport {
	drifted: boolean;
	/** rules in the live table that the computed policy does not have */
	extra: string[];
	/** rules the computed policy has that the live table does not */
	missing: string[];
}

function ruleLines(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.endsWith('{') && line !== '}');
}

/**
 * Compares the live table against the computed policy.
 *
 * A rule an operator added by hand is reported rather than removed, because silently reverting
 * someone's firewall change is how a security tool gets turned off. `egress.policy_drift` is the
 * tripwire; the repair is a command the operator runs.
 */
export async function checkDrift(
	ctx: Context,
	tenant: string,
	rules: EgressRule[]
): Promise<DriftReport> {
	const wanted = ruleLines(nftablesProgram(tenant, rules));
	const live = await ctx.runner.run('nft', ['list', 'table', 'inet', TABLE]);
	const have = ruleLines(live.stdout);
	const extra = have.filter((line) => !wanted.includes(line));
	const missing = wanted.filter((line) => !have.includes(line));
	return { drifted: extra.length > 0 || missing.length > 0, extra, missing };
}

/** answers `egress test <tenant> <host:port>` from the policy rather than by opening a socket */
export function wouldAllow(
	rules: EgressRule[],
	target: string
): { allowed: boolean; reason: string } {
	const rule = parseRule(target);
	const match = rules.find((r) => r.host === rule.host && r.port === rule.port);
	if (match !== undefined)
		return { allowed: true, reason: `allowed by ${rule.host}:${rule.port}` };
	return {
		allowed: false,
		reason:
			rules.length === 0
				? 'this tenant has no egress allow list, so everything is denied'
				: `not in the allow list: ${rules.map((r) => `${r.host}:${r.port}`).join(', ')}`
	};
}
