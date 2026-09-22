import { BastionError } from '../errors';

/** labels a tenant may never take, because they are bastion's own or they mislead */
export const RESERVED_LABELS = new Set([
	'www',
	'mail',
	'smtp',
	'imap',
	'ns',
	'ns1',
	'ns2',
	'admin',
	'api',
	'bastion',
	'dashboard',
	'status',
	'health',
	'metrics',
	'control',
	'root',
	'test',
	'staging',
	'localhost',
	'_acme-challenge',
	'_bastion-challenge'
]);

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export interface PrimaryDomain {
	/** the zone every allocated name sits under, e.g. `sites.example.edu` */
	domain: string;
	/** labels an operator has additionally reserved */
	reserved?: string[];
}

export type LabelOutcome = { ok: true; host: string } | { ok: false; reason: string };

/**
 * Whether a tenant may take a label under the primary domain.
 *
 * The rules are DNS's plus two of bastion's own. A reserved label is refused because `www` and
 * `admin` under an institution's own domain read as the institution rather than as one student.
 * And a label that only differs from a taken one by case or by a trailing dot is the same name in
 * DNS, so it is refused as taken rather than allocated twice.
 */
export function checkLabel(
	label: string,
	primary: PrimaryDomain,
	taken: Iterable<string> = []
): LabelOutcome {
	const normalised = label.trim().toLowerCase().replace(/\.$/, '');
	if (normalised === '') return { ok: false, reason: 'a name cannot be empty' };
	if (normalised.length > 63) {
		return { ok: false, reason: 'a DNS label is at most 63 characters' };
	}
	if (!LABEL.test(normalised)) {
		return {
			ok: false,
			reason: 'a name may use a to z, 0 to 9 and hyphens, and may not start or end with a hyphen'
		};
	}
	if (RESERVED_LABELS.has(normalised) || (primary.reserved ?? []).includes(normalised)) {
		return { ok: false, reason: `${normalised} is reserved` };
	}
	const host = `${normalised}.${primary.domain.toLowerCase().replace(/\.$/, '')}`;
	for (const existing of taken) {
		if (existing.toLowerCase().replace(/\.$/, '') === host) {
			return { ok: false, reason: `${host} is already taken` };
		}
	}
	return { ok: true, host };
}

export function allocate(
	label: string,
	primary: PrimaryDomain,
	taken: Iterable<string> = []
): string {
	const outcome = checkLabel(label, primary, taken);
	if (!outcome.ok) {
		throw new BastionError('usage', outcome.reason, { next: 'bastion domain list' });
	}
	return outcome.host;
}

/** whether a host sits under the primary domain, which is what skips the ownership proof */
export function isUnderPrimary(host: string, primary: PrimaryDomain): boolean {
	const suffix = `.${primary.domain.toLowerCase().replace(/\.$/, '')}`;
	const name = host.toLowerCase().replace(/\.$/, '');
	return name.endsWith(suffix) && name.slice(0, -suffix.length).split('.').length === 1;
}

/**
 * Suggests a free label from a preferred one.
 *
 * Appends a number rather than a random suffix, because the name is going in front of a human and
 * `alice-2` is something they can read out loud.
 */
export function suggest(
	preferred: string,
	primary: PrimaryDomain,
	taken: Iterable<string> = []
): string {
	const existing = [...taken];
	const base = preferred
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/^-+|-+$/g, '');
	for (let n = 0; n < 100; n++) {
		const candidate = n === 0 ? base : `${base}-${n + 1}`;
		const outcome = checkLabel(candidate, primary, existing);
		if (outcome.ok) return outcome.host;
	}
	throw new BastionError('usage', `no free name near ${preferred}`);
}

export const APEX_PREFIXES = ['www.'] as const;

/** the apex a `www` name belongs to, or null when it is not one */
export function apexOf(host: string): string | null {
	const name = host.toLowerCase().replace(/\.$/, '');
	for (const prefix of APEX_PREFIXES) {
		if (name.startsWith(prefix)) return name.slice(prefix.length);
	}
	return null;
}
