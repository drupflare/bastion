import type { BastionConfig } from '../config/types';
import type { Context } from '../context';
import type { FrontDeps } from './handler';
import type { ListenerSpec, TlsMaterial } from './listener';
import { ConnectionCounter, RateLimiter } from './ratelimit';
import { routeTable, type Route } from './router';

export interface DoorOptions {
	/** hands the sanitised request to the tenant's workerd, or to the site's primary node */
	upstream(route: Route, request: Request, client: string): Promise<Response>;
	hsts?: boolean;
}

/**
 * Builds the front door from the configuration.
 *
 * One place that reads `front.*`, so a key an operator sets is a key something acts on. The
 * reachability check walks the config for keys nothing reads, and every one of these was a finding
 * until this existed.
 */
export function buildFront(ctx: Context, config: BastionConfig, options: DoorOptions): FrontDeps {
	return {
		table: routeTable(config),
		trust: { trustedProxies: config.front.trustedProxies },
		perIp: new RateLimiter({
			rate: config.front.rateLimit.perIp,
			burst: Math.max(1, config.front.rateLimit.perIp)
		}),
		perTenant: new RateLimiter({
			rate: config.front.rateLimit.perTenant,
			burst: Math.max(1, config.front.rateLimit.perTenant)
		}),
		connections: new ConnectionCounter(config.front.maxConnectionsPerIp),
		compression: config.front.compression,
		maxBodyBytes: config.front.maxBodyBytes,
		now: ctx.now,
		upstream: options.upstream,
		...(options.hsts === undefined ? {} : { hsts: options.hsts })
	};
}

/**
 * The listener options the configuration asks for.
 *
 * `http3` is off in 1.0.0 and passing it anyway would be worse than ignoring it: Bun auto-emits
 * `Alt-Svc: h3=":<port>"; ma=86400` which cannot be suppressed, and a campus firewall blocking UDP
 * 443 turns that into one failed QUIC attempt per client, cached for a day. WebSocket over h3 is
 * also unsupported, and bastion needs WebSockets for live logs and `tail`.
 */
export function listenerSpec(
	config: BastionConfig,
	which: 'http' | 'https',
	tls?: TlsMaterial[]
): ListenerSpec & { http2: boolean; http3: boolean; headerTimeoutMs: number } {
	const listener = which === 'https' ? config.listeners.https : config.listeners.http;
	return {
		address: listener?.address ?? (which === 'https' ? '0.0.0.0:443' : '0.0.0.0:80'),
		reusePort: true,
		http2: config.front.http2,
		http3: config.front.http3,
		headerTimeoutMs: config.front.headerTimeoutMs,
		...(tls === undefined ? {} : { tls })
	};
}

/** why h3 is refused, printed rather than silently ignored when a config asks for it */
export const HTTP3_REFUSAL =
	'http3 is off in this version: WebSocket over h3 is unsupported and bastion needs WebSockets, ' +
	'and Bun emits an Alt-Svc advertisement that cannot be suppressed. Front bastion with Caddy or ' +
	'nginx for h3.';

export function http3Warning(config: BastionConfig): string | null {
	return config.front.http3 ? HTTP3_REFUSAL : null;
}
