import type { Mode } from '../config/types';
import { BastionError } from '../errors';

/** what each mode puts around a tenant's workerd process */
export interface ModeDescription {
	mode: Mode;
	boundary: string;
	/** whether this mode may host mutually untrusted tenants */
	multiTenantSafe: boolean;
	/** the mechanisms a host must provide for this mode to run at all */
	requires: string[];
}

/**
 * The three modes.
 *
 * Every one runs ONE workerd process per tenant; the mode chooses how strong the wall around that
 * process is. That is a departure from reading the roadmap's table as "solo shares a runtime", and
 * it is what makes a cgroup limit bind, a tenant change restart one tenant, and a Durable Object
 * domain be per tenant rather than per host.
 */
export const MODE_TABLE: Record<Mode, ModeDescription> = {
	solo: {
		mode: 'solo',
		boundary: 'the host; cgroups v2 for cpu, memory and pids',
		multiTenantSafe: false,
		requires: ['cgroups-v2']
	},
	hardened: {
		mode: 'hardened',
		boundary: 'a network namespace, seccomp and AppArmor around each tenant process',
		multiTenantSafe: false,
		requires: ['cgroups-v2', 'netns', 'seccomp', 'apparmor']
	},
	isolated: {
		mode: 'isolated',
		boundary: 'one microVM per tenant',
		multiTenantSafe: true,
		requires: ['cgroups-v2', 'kvm']
	}
};

/** the flag an operator must pass to run more than one tenant in an unsafe mode */
export const ACKNOWLEDGE_FLAG = '--i-understand-this-is-not-multi-tenant-safe';

/**
 * The multi-tenant warning, printed before the refusal rather than instead of it.
 *
 * A Durable Object is a v8 isolate, and an isolate boundary is a correctness boundary rather than
 * a security one. Cloudflare has published a working Spectre read against co-located Workers in
 * production; on one box co-location is not something an attacker has to win.
 */
export function multiTenantWarning(mode: Mode, tenants: number): string {
	const description = MODE_TABLE[mode];
	return [
		`${tenants} tenants are configured and \`${mode}\` is not multi-tenant safe.`,
		`Its boundary is ${description.boundary}, which is a correctness boundary rather than a`,
		'security one: a runtime escape reaches every tenant behind the same wall.',
		'Use `--mode isolated` for mutually untrusted tenants, or pass',
		`\`${ACKNOWLEDGE_FLAG}\` if every tenant here is your own.`
	].join('\n');
}

/**
 * Refuses an unsafe mode carrying more than one tenant.
 *
 * One tenant is always fine: there is nobody to isolate it from.
 */
export function assertModeSafe(
	mode: Mode,
	tenants: number,
	acknowledged = false
): { warned: boolean; warning: string } {
	if (MODE_TABLE[mode].multiTenantSafe || tenants <= 1) {
		return { warned: false, warning: '' };
	}
	const warning = multiTenantWarning(mode, tenants);
	if (!acknowledged) {
		throw new BastionError('multi-tenant-unsafe', warning, {
			next: `bastion serve --mode isolated`
		});
	}
	return { warned: true, warning };
}
