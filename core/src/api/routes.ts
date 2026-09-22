import type { Action } from './authz';

export interface RouteDefinition {
	method: string;
	path: string;
	action: Action;
	/** whether an API token may use it, or only an interactive session */
	token: boolean;
	/** the CLI command that reaches the same thing, so neither surface can grow alone */
	command: string;
}

/**
 * The management surface, as one table.
 *
 * Every entry names the action it authorises against, so the authorization spec can walk the table
 * and fail on a route that does not call the one authz function. That is the `check:reachability`
 * shape pointed at authorization: the failure it prevents is a new route shipped without a check,
 * which no test would otherwise notice.
 */
export const ROUTES: RouteDefinition[] = [
	{
		method: 'GET',
		path: '/api/status',
		action: 'host.read',
		token: true,
		command: 'bastion status'
	},
	{
		method: 'GET',
		path: '/api/doctor',
		action: 'host.read',
		token: true,
		command: 'bastion doctor'
	},
	{
		method: 'GET',
		path: '/api/health',
		action: 'host.read',
		token: true,
		command: 'bastion health'
	},
	{
		method: 'GET',
		path: '/api/metrics',
		action: 'metrics.read',
		token: true,
		command: 'bastion metrics'
	},
	{ method: 'GET', path: '/api/logs', action: 'logs.read', token: true, command: 'bastion logs' },
	{
		method: 'GET',
		path: '/api/config',
		action: 'config.read',
		token: false,
		command: 'bastion config show'
	},
	{
		method: 'PUT',
		path: '/api/config',
		action: 'config.write',
		token: false,
		command: 'bastion config set'
	},
	{
		method: 'GET',
		path: '/api/tenants',
		action: 'tenant.read',
		token: true,
		command: 'bastion tenant list'
	},
	{
		method: 'POST',
		path: '/api/tenants',
		action: 'tenant.write',
		token: false,
		command: 'bastion tenant add'
	},
	{
		method: 'DELETE',
		path: '/api/tenants/:tenant',
		action: 'tenant.write',
		token: false,
		command: 'bastion tenant rm'
	},
	{
		method: 'GET',
		path: '/api/sites',
		action: 'site.read',
		token: true,
		command: 'bastion site list'
	},
	{
		method: 'POST',
		path: '/api/sites',
		action: 'site.write',
		token: true,
		command: 'bastion site add'
	},
	{
		method: 'DELETE',
		path: '/api/sites/:site',
		action: 'site.write',
		token: false,
		command: 'bastion site rm'
	},
	{
		method: 'POST',
		path: '/api/sites/:site/deploy',
		action: 'deploy',
		token: true,
		command: 'bastion deploy'
	},
	{
		method: 'POST',
		path: '/api/sites/:site/rollout',
		action: 'deploy',
		token: true,
		command: 'bastion rollout'
	},
	{
		method: 'POST',
		path: '/api/sites/:site/rollback',
		action: 'rollback',
		token: true,
		command: 'bastion rollback'
	},
	{
		method: 'GET',
		path: '/api/versions',
		action: 'site.read',
		token: true,
		command: 'bastion version list'
	},
	{
		method: 'GET',
		path: '/api/backups',
		action: 'host.read',
		token: true,
		command: 'bastion backup list'
	},
	{
		method: 'POST',
		path: '/api/backups',
		action: 'host.write',
		token: false,
		command: 'bastion backup now'
	},
	{
		method: 'POST',
		path: '/api/repair/:code',
		action: 'host.write',
		token: false,
		command: 'bastion repair'
	},
	{
		method: 'GET',
		path: '/api/quarantine',
		action: 'host.read',
		token: true,
		command: 'bastion quarantine list'
	},
	{
		method: 'GET',
		path: '/api/secrets',
		action: 'secrets.read',
		token: false,
		command: 'bastion secrets list'
	},
	{
		method: 'PUT',
		path: '/api/secrets/:name',
		action: 'secrets.write',
		token: false,
		command: 'bastion secrets set'
	},
	{
		method: 'GET',
		path: '/api/audit',
		action: 'audit.read',
		token: false,
		command: 'bastion audit tail'
	},
	{
		method: 'GET',
		path: '/api/cluster',
		action: 'cluster.read',
		token: true,
		command: 'bastion cluster status'
	},
	{
		method: 'POST',
		path: '/api/cluster/nodes',
		action: 'cluster.write',
		token: false,
		command: 'bastion cluster join'
	},
	{
		method: 'GET',
		path: '/api/capacity',
		action: 'host.read',
		token: true,
		command: 'bastion capacity'
	}
];

export function routeFor(method: string, path: string): RouteDefinition | null {
	const parts = path.split('/');
	for (const route of ROUTES) {
		if (route.method !== method.toUpperCase()) continue;
		const pattern = route.path.split('/');
		if (pattern.length !== parts.length) continue;
		const matches = pattern.every(
			(segment, index) => segment.startsWith(':') || segment === parts[index]
		);
		if (matches) return route;
	}
	return null;
}

/** the named parameters in a matched path, which are NEVER used to decide authorization */
export function pathParams(route: RouteDefinition, path: string): Record<string, string> {
	const parts = path.split('/');
	const out: Record<string, string> = {};
	route.path.split('/').forEach((segment, index) => {
		if (segment.startsWith(':')) out[segment.slice(1)] = parts[index] ?? '';
	});
	return out;
}
