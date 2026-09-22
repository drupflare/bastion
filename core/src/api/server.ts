import type { BastionConfig } from '../config/types';
import type { Context } from '../context';
import { BastionError, EXIT } from '../errors';
import {
	checkCsrf,
	CSRF_HEADER,
	nonce,
	readCookie,
	securityHeaders,
	SESSION_COOKIE
} from '../serve/security';
import type { SessionStore } from '../serve/session';
import { bearer, type TokenStore } from '../serve/tokens';
import { authorize, tenantFor, type Principal } from './authz';
import { pathParams, routeFor, type RouteDefinition } from './routes';

export interface ApiDeps {
	config: BastionConfig;
	sessions: SessionStore;
	tokens: TokenStore;
	/** the origin the management listener answers on, for the CSRF fallback */
	origin: string;
	/** every handler receives the principal and the route's parameters, never a raw tenant name */
	handlers: Record<string, ApiHandler>;
	/** records the principal and what they did; every action lands here */
	audit?(event: {
		event: string;
		principal: string;
		tenant: string | null;
		detail: unknown;
	}): void;
}

export type ApiHandler = (input: {
	ctx: Context;
	principal: Principal;
	tenant: string | null;
	params: Record<string, string>;
	request: Request;
}) => Promise<unknown> | unknown;

/** identity, which every credential may read about itself and about nothing else */
export const SESSION_PATH = '/api/session';

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', ...extra }
	});
}

/**
 * Resolves the credential a request carries.
 *
 * A bearer token and a session are separate paths on purpose: a token is scoped and revocable and
 * may not reach the routes that change the host or read a secret, and the route table says which.
 */
export function principalFor(request: Request, deps: ApiDeps): Principal | null {
	const token = deps.tokens.resolve(bearer(request));
	if (token !== null) return token;
	const session = deps.sessions.get(readCookie(request.headers.get('cookie'), SESSION_COOKIE));
	return session?.principal ?? null;
}

/**
 * The management API.
 *
 * Every route goes through this one function, and this one function calls `authorize` before it
 * reaches a handler. A spec walks the route table and fails on any route that is not reachable
 * here, which is the `check:reachability` shape pointed at authorization: the failure it prevents
 * is a new route shipped without a check, which no other test would notice.
 *
 * **The tenant is derived from the credential, never from the path.** `/api/sites/:site` carries a
 * site name and the handler receives it, but authorization has already been decided from the
 * principal. The worker shipped the other shape once: `/serve` read `?site=` raw, and one
 * unauthenticated request provisioned an entire database.
 */
export async function handleApi(ctx: Context, request: Request, deps: ApiDeps): Promise<Response> {
	const url = new URL(request.url);
	const scriptNonce = nonce();
	const headers = securityHeaders(scriptNonce, url.protocol === 'https:');

	const principal = principalFor(request, deps);
	const unauthenticated = (): Response =>
		json(
			{ ok: false, error: { code: 'unauthenticated', message: 'no session and no token' } },
			401,
			headers
		);

	// answered here rather than from the handler map, because it carries no action: it tells a
	// caller who they already are. A deployment that forgot to wire it would leave the dashboard
	// unable to learn its own principal, which renders as a blank page rather than as an error
	if (request.method === 'GET' && url.pathname === SESSION_PATH) {
		if (principal === null) return unauthenticated();
		const session = deps.sessions.get(
			readCookie(request.headers.get('cookie'), SESSION_COOKIE)
		);
		return json(
			{
				ok: true,
				result: {
					id: principal.id,
					role: principal.role,
					tenant: principal.tenant,
					credential: principal.credential,
					csrf: session?.csrfToken ?? null
				}
			},
			200,
			{ ...headers, 'x-bastion-nonce': scriptNonce }
		);
	}

	const route: RouteDefinition | null = routeFor(request.method, url.pathname);
	if (route === null) {
		return json(
			{ ok: false, error: { code: 'not-found', message: 'no such route' } },
			404,
			headers
		);
	}

	if (principal === null) return unauthenticated();

	if (principal.credential === 'token' && !route.token) {
		return json(
			{
				ok: false,
				error: {
					code: 'capability-refused',
					message: `${route.path} needs an interactive session rather than an API token`
				}
			},
			403,
			headers
		);
	}

	if (principal.credential === 'session') {
		const session = deps.sessions.get(
			readCookie(request.headers.get('cookie'), SESSION_COOKIE)
		);
		const csrf = checkCsrf(request, session?.csrfToken ?? null, deps.origin);
		if (!csrf.ok) {
			return json({ ok: false, error: { code: 'csrf', message: csrf.reason } }, 403, headers);
		}
	}

	const params = pathParams(route, url.pathname);
	const named = url.searchParams.get('tenant');
	const tenant = tenantFor(principal, named);

	try {
		authorize({ principal, action: route.action, tenant });
	} catch (e) {
		const error = e instanceof BastionError ? e : new BastionError('internal', String(e));
		return json(error.toJSON(), 403, headers);
	}

	const handler = deps.handlers[`${route.method} ${route.path}`];
	if (handler === undefined) {
		return json(
			{
				ok: false,
				error: { code: 'not-implemented', message: `${route.path} has no handler` }
			},
			501,
			headers
		);
	}

	try {
		const body = await handler({ ctx, principal, tenant, params, request });
		deps.audit?.({
			event: `api.${route.action}`,
			principal: principal.id,
			tenant,
			detail: { method: route.method, path: url.pathname }
		});
		return json({ ok: true, result: body }, 200, {
			...headers,
			'x-bastion-nonce': scriptNonce
		});
	} catch (e) {
		if (e instanceof BastionError) {
			return json(e.toJSON(), e.exitCode === EXIT.USAGE ? 400 : 500, headers);
		}
		return json(
			{
				ok: false,
				error: { code: 'internal', message: e instanceof Error ? e.message : String(e) }
			},
			500,
			headers
		);
	}
}

/** the header a browser client must send with every write, alongside the session cookie */
export { CSRF_HEADER };
