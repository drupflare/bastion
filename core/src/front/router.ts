import { DEFAULT_CAPABILITIES } from '../config/defaults';
import type { BastionConfig, SiteConfig, TenantCapabilities, TenantConfig } from '../config/types';

export interface Route {
	host: string;
	tenant: string;
	site: string;
	capabilities: TenantCapabilities;
	/** the node holding the authoritative Durable Object; the local node when unset */
	primary: string | null;
	replicas: string[];
	/** every name that reaches this site, the canonical one first */
	names: string[];
	/** the name aliases redirect to, or null to serve each alias as itself */
	canonical: string | null;
	forceHttps: boolean;
	headers?: SiteConfig['headers'];
}

export interface RouteTable {
	byHost: Map<string, Route>;
}

/**
 * The diagnostic set the drupflare bundle gates behind one variable.
 *
 * The worker's `PW_DIAGNOSTICS` covers all five at once and the roadmap records that granularity
 * as a known defect. bastion cannot fix the worker's flag, and does not have to: the front door
 * refuses these per route and per tenant, outside the site's control, so a compromised site
 * cannot flip a value it never sees.
 */
export const DIAGNOSTIC_ROUTES = ['/php', '/sql', '/restore', '/replica', '/plan'] as const;

/** strips the port and lowercases, so `Example.edu:8443` and `example.edu` are one key */
export function normaliseHost(host: string): string {
	const trimmed = host.trim().toLowerCase();
	if (trimmed.startsWith('[')) {
		const end = trimmed.indexOf(']');
		return end === -1 ? trimmed : trimmed.slice(0, end + 1);
	}
	const colon = trimmed.lastIndexOf(':');
	return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

export function capabilitiesFor(tenant: TenantConfig): TenantCapabilities {
	return { ...DEFAULT_CAPABILITIES, ...(tenant.capabilities ?? {}) };
}

export function routeTable(config: BastionConfig): RouteTable {
	const byHost = new Map<string, Route>();
	for (const tenant of config.tenants) {
		const caps = capabilitiesFor(tenant);
		for (const site of tenant.sites) {
			const names = [site.host, ...(site.aliases ?? [])];
			const route: Route = {
				host: site.host,
				tenant: tenant.name,
				site: site.host,
				capabilities: caps,
				primary: site.primary ?? null,
				replicas: site.replicas ?? [],
				names,
				canonical: site.canonical ?? null,
				forceHttps: site.forceHttps ?? false,
				...(site.headers === undefined ? {} : { headers: site.headers })
			};
			// every alias resolves to the SAME route object, so a redirect decision and a header
			// policy cannot differ depending on which name a request arrived under
			for (const name of names) byHost.set(normaliseHost(name), route);
		}
	}
	return { byHost };
}

export type RouteOutcome =
	{ ok: true; route: Route } | { ok: false; status: number; reason: string };

/** whether a pathname falls inside the diagnostic set, matching the route and anything under it */
export function isDiagnosticPath(pathname: string): boolean {
	return DIAGNOSTIC_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

/**
 * Host to site to tenant, then the per-tenant route refusal.
 *
 * An unknown host is 404 rather than a default site: serving the wrong tenant's content under an
 * unrecognised name is how a misconfigured DNS record becomes a data leak.
 */
export function resolveRoute(
	table: RouteTable,
	host: string | null,
	pathname: string
): RouteOutcome {
	if (host === null || host.trim() === '') {
		return { ok: false, status: 400, reason: 'no Host header' };
	}
	const route = table.byHost.get(normaliseHost(host));
	if (route === undefined) {
		return {
			ok: false,
			status: 404,
			reason: `no site is configured for ${normaliseHost(host)}`
		};
	}
	if (!route.capabilities.diagnosticRoutes && isDiagnosticPath(pathname)) {
		return {
			ok: false,
			status: 404,
			reason: `the diagnostic routes are off for tenant ${route.tenant}`
		};
	}
	return { ok: true, route };
}
