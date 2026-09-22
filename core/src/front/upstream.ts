import type { Context } from '../context';
import type { Route } from './router';

export interface UpstreamPaths {
	/** the unix socket a tenant's workerd listens on */
	socketFor(tenant: string): string;
}

/**
 * Proxies a sanitised request to the tenant's workerd.
 *
 * Over a unix socket rather than a loopback port: a port is reachable by every other tenant on the
 * box, and the whole point of one process per tenant is that they cannot address each other. The
 * socket lives in the tenant's own state directory, which its AppArmor profile is the only one to
 * grant.
 *
 * The URL's host is replaced with a placeholder because the socket decides the destination, and
 * the real Host rides in the header, byte-identical to what arrived. That is the value Drupal
 * derives its session cookie name from.
 */
export function unixUpstream(ctx: Context, paths: UpstreamPaths) {
	return async (route: Route, request: Request, client: string): Promise<Response> => {
		void client;
		const url = new URL(request.url);
		const target = `http://localhost${url.pathname}${url.search}`;
		return ctx.fetch(target, {
			method: request.method,
			headers: request.headers,
			...(request.body === null ? {} : { body: request.body, duplex: 'half' }),
			redirect: 'manual',
			// bun reads this; under node the dispatcher is supplied by the caller's fetch seam
			unix: paths.socketFor(route.tenant)
		} as RequestInit);
	};
}

/** where each tenant's socket lives, derived from the state directory rather than configured */
export function socketPaths(state: string): UpstreamPaths {
	return { socketFor: (tenant) => `${state}/tenants/${tenant}/workerd.sock` };
}
