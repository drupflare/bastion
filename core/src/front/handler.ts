import { resolveClientIp, sanitiseInbound, type TrustPolicy } from './client-ip';
import { chooseEncoding, compress, type CompressionPolicy } from './compress';
import { applyHeaders, defaultResponseHeaders } from './headers';
import { ConnectionCounter, RateLimiter } from './ratelimit';
import { redirectFor, redirectResponse } from './redirect';
import { resolveRoute, type Route, type RouteTable } from './router';

export interface FrontDeps {
	table: RouteTable;
	trust: TrustPolicy;
	perIp: RateLimiter;
	perTenant: RateLimiter;
	connections?: ConnectionCounter;
	compression: CompressionPolicy;
	maxBodyBytes: number;
	now(): number;
	/** hands the sanitised request to that tenant's workerd, or to the site's primary node */
	upstream(route: Route, request: Request, client: string): Promise<Response>;
	/** set on the public listener only; an internal hop must not advertise it */
	hsts?: boolean;
}

export interface FrontOutcome {
	response: Response;
	/** null when the request never reached a site */
	route: Route | null;
	client: string;
	/** the reason a request was refused here rather than upstream, for the log line */
	refusal: string | null;
}

/** a stream that fails rather than truncating once `max` bytes have passed through it */
export function limitBody(
	body: ReadableStream<Uint8Array>,
	max: number
): ReadableStream<Uint8Array> {
	let seen = 0;
	const reader = body.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) {
				controller.close();
				return;
			}
			seen += value.byteLength;
			if (seen > max) {
				await reader.cancel();
				controller.error(new Error(`request body exceeded ${max} bytes`));
				return;
			}
			controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
}

function refuse(status: number, reason: string, extra: Record<string, string> = {}): Response {
	return new Response(`${reason}\n`, {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', ...extra }
	});
}

/**
 * One request through the front door.
 *
 * A pure function of the request, the peer address and its dependencies, so the gate lane drives
 * the whole path -- rate limits, body caps, the address rewrite, compression -- with no socket.
 * The listener binds this to a real port and owns nothing else.
 *
 * Order matters and is not arbitrary: the address is resolved first because every later decision
 * keys on it, the per-IP limit runs before routing so an unknown host cannot be used as a free
 * probe, and the body cap runs before the upstream call so a large body is never buffered for a
 * tenant that would have refused it anyway.
 */
export async function handleRequest(
	request: Request,
	peer: string,
	deps: FrontDeps
): Promise<FrontOutcome> {
	const client = resolveClientIp(peer, request.headers, deps.trust);
	const url = new URL(request.url);

	const perIp = deps.perIp.take(client, deps.now());
	if (!perIp.allowed) {
		return {
			response: refuse(429, 'rate limited', {
				'retry-after': String(Math.ceil(perIp.retryAfterMs / 1000))
			}),
			route: null,
			client,
			refusal: 'rate-limit-ip'
		};
	}

	const outcome = resolveRoute(deps.table, request.headers.get('host'), url.pathname);
	if (!outcome.ok) {
		return {
			response: refuse(outcome.status, outcome.reason),
			route: null,
			client,
			refusal: outcome.status === 404 ? 'no-route' : 'bad-request'
		};
	}
	const route = outcome.route;

	// the redirect is decided BEFORE the tenant's rate limit is spent, because a request that is
	// about to be sent somewhere else never reaches the tenant and should not count against it
	const redirect = redirectFor(url, request.headers.get('host') ?? route.host, {
		canonical: route.canonical,
		aliases: route.names,
		forceHttps: route.forceHttps
	});
	if (redirect !== null) {
		return { response: redirectResponse(redirect), route, client, refusal: null };
	}

	const perTenant = deps.perTenant.take(route.tenant, deps.now());
	if (!perTenant.allowed) {
		return {
			response: refuse(429, 'rate limited', {
				'retry-after': String(Math.ceil(perTenant.retryAfterMs / 1000))
			}),
			route,
			client,
			refusal: 'rate-limit-tenant'
		};
	}

	const declared = request.headers.get('content-length');
	if (declared !== null && Number(declared) > deps.maxBodyBytes) {
		return {
			response: refuse(413, `body exceeds ${deps.maxBodyBytes} bytes`),
			route,
			client,
			refusal: 'body-cap'
		};
	}

	const headers = applyHeaders(
		sanitiseInbound(request.headers, peer, deps.trust),
		route.headers?.request,
		url.pathname,
		'request'
	);
	// the Host is forwarded byte-identical. Drupal derives its session cookie name from the host,
	// so a node that forwards a different one renders every visitor anonymous -- deterministically,
	// and the pool already shipped that defect once
	headers.set('host', request.headers.get('host') ?? route.host);

	const body = request.body === null ? null : limitBody(request.body, deps.maxBodyBytes);
	const forwarded = new Request(request.url, {
		method: request.method,
		headers,
		body,
		redirect: 'manual',
		...(body === null ? {} : { duplex: 'half' })
	} as RequestInit);

	let response: Response;
	try {
		response = await deps.upstream(route, forwarded, client);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (message.includes('exceeded')) {
			return {
				response: refuse(413, `body exceeds ${deps.maxBodyBytes} bytes`),
				route,
				client,
				refusal: 'body-cap'
			};
		}
		return {
			response: refuse(502, 'the site is not answering'),
			route,
			client,
			refusal: 'upstream-unreachable'
		};
	}

	return {
		response: await finishResponse(request, response, deps, route),
		route,
		client,
		refusal: null
	};
}

/** compression and the response headers workerd does not set for us */
export async function finishResponse(
	request: Request,
	response: Response,
	deps: FrontDeps,
	route?: Route
): Promise<Response> {
	const headers = defaultResponseHeaders(
		applyHeaders(
			response.headers,
			route?.headers?.response,
			new URL(request.url).pathname,
			'response'
		)
	);
	if (deps.hsts === true) {
		headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
	}
	if (response.body === null || headers.has('content-encoding') || response.status === 204) {
		return new Response(response.body, { status: response.status, headers });
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	const encoding = chooseEncoding(
		request.headers.get('accept-encoding'),
		headers.get('content-type'),
		bytes.byteLength,
		deps.compression
	);
	if (encoding === null) {
		headers.set('content-length', String(bytes.byteLength));
		return new Response(bytes, { status: response.status, headers });
	}
	const packed = compress(encoding, bytes);
	headers.set('content-encoding', encoding);
	headers.set('content-length', String(packed.byteLength));
	headers.append('vary', 'accept-encoding');
	return new Response(packed, { status: response.status, headers });
}
