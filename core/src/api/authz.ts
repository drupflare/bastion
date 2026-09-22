import { BastionError } from '../errors';

export const ROLES = ['operator', 'tenant-admin', 'tenant-viewer'] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
	id: string;
	role: Role;
	/** the tenant this credential is scoped to; null only for an operator */
	tenant: string | null;
	/** `session` or `token`, so an audit line says which credential was used */
	credential: 'session' | 'token';
}

export type Action =
	| 'host.read'
	| 'host.write'
	| 'config.read'
	| 'config.write'
	| 'tenant.read'
	| 'tenant.write'
	| 'site.read'
	| 'site.write'
	| 'deploy'
	| 'rollback'
	| 'logs.read'
	| 'metrics.read'
	| 'secrets.read'
	| 'secrets.write'
	| 'cluster.read'
	| 'cluster.write'
	| 'audit.read';

/**
 * What each role may do.
 *
 * Three roles and no more. bastion does not model content permissions: Drupal already has roles,
 * and the drupflare module already defines the three tiers that matter. Rebuilding any of that
 * above the CMS would be an abstraction drawn against one implementation, and it would put CMS
 * knowledge in a core that is deliberately CMS-agnostic.
 */
export const GRANTS: Record<Role, Action[]> = {
	operator: [
		'host.read',
		'host.write',
		'config.read',
		'config.write',
		'tenant.read',
		'tenant.write',
		'site.read',
		'site.write',
		'deploy',
		'rollback',
		'logs.read',
		'metrics.read',
		'secrets.read',
		'secrets.write',
		'cluster.read',
		'cluster.write',
		'audit.read'
	],
	'tenant-admin': [
		'tenant.read',
		'site.read',
		'site.write',
		'deploy',
		'rollback',
		'logs.read',
		'metrics.read'
	],
	'tenant-viewer': ['tenant.read', 'site.read', 'logs.read', 'metrics.read']
};

export interface AuthzRequest {
	principal: Principal;
	action: Action;
	/** the tenant the request is ABOUT, derived by the caller from the session, never from input */
	tenant?: string | null;
}

/**
 * The one authorization function, called by every route.
 *
 * **The tenant comes from the SESSION, never from a path, a query or a body.** This is the exact
 * defect the worker already shipped once: `/serve` read `?site=` raw, so one unauthenticated
 * request provisioned an entire Drupal database, and site ids are host-derived and guessable. A
 * route that needs to know which tenant a request concerns gets it from the principal, and the
 * only case where a client-supplied name is consulted is an operator naming a tenant they already
 * have blanket access to.
 */
export function authorize(request: AuthzRequest): void {
	const { principal, action } = request;
	const granted = GRANTS[principal.role] ?? [];
	if (!granted.includes(action)) {
		throw new BastionError('capability-refused', `${principal.role} may not ${action}`, {
			exitCode: 2
		});
	}
	if (principal.role === 'operator') return;

	if (principal.tenant === null) {
		throw new BastionError(
			'capability-refused',
			`a ${principal.role} credential with no tenant reaches nothing`
		);
	}
	const about = request.tenant ?? principal.tenant;
	if (about !== principal.tenant) {
		throw new BastionError(
			'capability-refused',
			`that credential is scoped to ${principal.tenant} and cannot reach ${about}`
		);
	}
}

/** the tenant a request acts on, which is the principal's own unless an operator named one */
export function tenantFor(principal: Principal, named?: string | null): string | null {
	if (principal.role === 'operator') return named ?? null;
	return principal.tenant;
}

export function can(principal: Principal, action: Action, tenant?: string | null): boolean {
	try {
		authorize({ principal, action, ...(tenant === undefined ? {} : { tenant }) });
		return true;
	} catch {
		return false;
	}
}
