import { describe, expect, it } from 'vitest';
import { ROUTES } from '../../../src/api/routes';
import { handleApi, principalFor, SESSION_PATH, type ApiDeps } from '../../../src/api/server';
import { defaultConfig } from '../../../src/config/defaults';
import { defaultContext } from '../../../src/context';
import { memoryIo } from '../../../src/io';
import { CSRF_HEADER, SESSION_COOKIE } from '../../../src/serve/security';
import { hashPassword, SessionStore, type Account } from '../../../src/serve/session';
import { TokenStore } from '../../../src/serve/tokens';

const ORIGIN = 'https://127.0.0.1:8787';

interface ApiError {
	error: { code: string; message: string };
}
const CHEAP = { N: 1024, r: 8, p: 1 };

function ctx() {
	return { ...defaultContext(), io: memoryIo(), env: {}, now: () => 1000 };
}

function harness(over: Partial<ApiDeps> = {}) {
	const context = ctx();
	const sessions = new SessionStore(context);
	const tokens = new TokenStore(context);
	const audited: { event: string; principal: string }[] = [];
	const operator: Account = {
		id: 'op',
		role: 'operator',
		tenant: null,
		password: hashPassword('pw', undefined, CHEAP)
	};
	const session = sessions.login(operator, 'pw');
	const deps: ApiDeps = {
		config: defaultConfig(),
		sessions,
		tokens,
		origin: ORIGIN,
		handlers: {
			'GET /api/status': () => ({ up: true }),
			'GET /api/sites': ({ tenant }) => ({ tenant }),
			'POST /api/tenants': () => ({ created: true }),
			'GET /api/secrets': () => ({ secrets: [] }),
			'POST /api/sites/:site/deploy': ({ params }) => ({ site: params.site })
		},
		audit: (event) => void audited.push({ event: event.event, principal: event.principal }),
		...over
	};
	return { context, deps, sessions, tokens, session, audited };
}

function get(path: string, headers: Record<string, string> = {}): Request {
	return new Request(`${ORIGIN}${path}`, { headers });
}

function post(path: string, headers: Record<string, string> = {}): Request {
	return new Request(`${ORIGIN}${path}`, { method: 'POST', headers });
}

describe('handleApi', () => {
	it('serves a route to an authenticated operator', async () => {
		const { context, deps, session } = harness();
		const response = await handleApi(
			context,
			get('/api/status', { cookie: `${SESSION_COOKIE}=${session.id}` }),
			deps
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, result: { up: true } });
	});

	it('401s with no credential at all', async () => {
		const { context, deps } = harness();
		expect((await handleApi(context, get('/api/status'), deps)).status).toBe(401);
	});

	it('404s an unknown route rather than reaching a handler', async () => {
		const { context, deps, session } = harness();
		const response = await handleApi(
			context,
			get('/api/nonsense', { cookie: `${SESSION_COOKIE}=${session.id}` }),
			deps
		);
		expect(response.status).toBe(404);
	});

	it('sets the security headers on every response, including a refusal', async () => {
		const { context, deps } = harness();
		const response = await handleApi(context, get('/api/status'), deps);
		expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('refuses a write with no CSRF token, even from a valid session', async () => {
		const { context, deps, session } = harness();
		const response = await handleApi(
			context,
			post('/api/tenants', {
				cookie: `${SESSION_COOKIE}=${session.id}`,
				'sec-fetch-site': 'same-origin'
			}),
			deps
		);
		expect(response.status).toBe(403);
		expect(((await response.json()) as ApiError).error.code).toBe('csrf');
	});

	it('accepts a write carrying the session s own token', async () => {
		const { context, deps, session } = harness();
		const response = await handleApi(
			context,
			post('/api/tenants', {
				cookie: `${SESSION_COOKIE}=${session.id}`,
				'sec-fetch-site': 'same-origin',
				[CSRF_HEADER]: session.csrfToken
			}),
			deps
		);
		expect(response.status).toBe(200);
	});

	it('does not ask a bearer token for a CSRF token, which it cannot have', async () => {
		const { context, deps, tokens } = harness();
		const { secret } = tokens.create('ci', 'tenant-admin', 'acme');
		const response = await handleApi(
			context,
			new Request(`${ORIGIN}/api/sites/www.example.edu/deploy`, {
				method: 'POST',
				headers: { authorization: `Bearer ${secret}` }
			}),
			deps
		);
		expect(response.status).toBe(200);
	});

	it('refuses a token on a route the table marks session-only', async () => {
		const { context, deps, tokens } = harness();
		const { secret } = tokens.create('ci', 'tenant-admin', 'acme');
		const response = await handleApi(
			context,
			get('/api/secrets', { authorization: `Bearer ${secret}` }),
			deps
		);
		expect(response.status).toBe(403);
		expect(((await response.json()) as ApiError).error.message).toContain(
			'interactive session'
		);
	});

	it('takes the tenant from the credential and ignores one named in the query', async () => {
		const { context, deps, tokens } = harness();
		const { secret } = tokens.create('ci', 'tenant-admin', 'acme');
		const response = await handleApi(
			context,
			get('/api/sites?tenant=someone-else', { authorization: `Bearer ${secret}` }),
			deps
		);
		expect(await response.json()).toEqual({ ok: true, result: { tenant: 'acme' } });
	});

	it('refuses an action the role does not have', async () => {
		const { context, deps, tokens } = harness();
		const { secret } = tokens.create('ci', 'tenant-viewer', 'acme');
		const response = await handleApi(
			context,
			new Request(`${ORIGIN}/api/sites/www.example.edu/deploy`, {
				method: 'POST',
				headers: { authorization: `Bearer ${secret}` }
			}),
			deps
		);
		expect(response.status).toBe(403);
	});

	it('records the principal for every action it served', async () => {
		const { context, deps, session, audited } = harness();
		await handleApi(
			context,
			get('/api/status', { cookie: `${SESSION_COOKIE}=${session.id}` }),
			deps
		);
		expect(audited).toEqual([{ event: 'api.host.read', principal: 'op' }]);
	});

	it('answers 501 rather than 500 for a route with no handler yet', async () => {
		const { context, deps, session } = harness({ handlers: {} });
		const response = await handleApi(
			context,
			get('/api/status', { cookie: `${SESSION_COOKIE}=${session.id}` }),
			deps
		);
		expect(response.status).toBe(501);
	});

	it('maps a usage error onto 400 and anything else onto 500', async () => {
		const { context, deps, session } = harness({
			handlers: {
				'GET /api/status': () => {
					throw new Error('boom');
				}
			}
		});
		const response = await handleApi(
			context,
			get('/api/status', { cookie: `${SESSION_COOKIE}=${session.id}` }),
			deps
		);
		expect(response.status).toBe(500);
		expect(((await response.json()) as ApiError).error.code).toBe('internal');
	});
});

describe('every route is reachable through the one authorization path', () => {
	it('resolves every route in the table', () => {
		for (const route of ROUTES) {
			const path = route.path.replace(/:(\w+)/g, 'x');
			expect(
				routeName(route.method, path),
				`${route.method} ${route.path} does not resolve`
			).toBe(`${route.method} ${route.path}`);
		}
	});

	function routeName(method: string, path: string): string {
		const found = ROUTES.find((route) => {
			if (route.method !== method) return false;
			const pattern = route.path.split('/');
			const parts = path.split('/');
			return (
				pattern.length === parts.length &&
				pattern.every((segment, i) => segment.startsWith(':') || segment === parts[i])
			);
		});
		return found === undefined ? 'none' : `${found.method} ${found.path}`;
	}

	it('refuses every route for an unauthenticated caller', async () => {
		const { context, deps } = harness();
		for (const route of ROUTES) {
			const path = route.path.replace(/:(\w+)/g, 'x');
			const response = await handleApi(
				context,
				new Request(`${ORIGIN}${path}`, { method: route.method }),
				deps
			);
			expect(response.status, `${route.method} ${route.path} did not refuse`).toBe(401);
		}
	});

	it('refuses every write route for a viewer', async () => {
		const { context, deps, tokens } = harness();
		const { secret } = tokens.create('v', 'tenant-viewer', 'acme');
		for (const route of ROUTES.filter(
			(r) => r.action.endsWith('.write') || r.action === 'deploy'
		)) {
			const path = route.path.replace(/:(\w+)/g, 'x');
			const response = await handleApi(
				context,
				new Request(`${ORIGIN}${path}`, {
					method: route.method,
					headers: { authorization: `Bearer ${secret}` }
				}),
				deps
			);
			expect(response.status, `${route.method} ${route.path} let a viewer through`).toBe(403);
		}
	});
});

describe('principalFor', () => {
	it('prefers a bearer token over a cookie, so a token call is never a session call', () => {
		const { context, deps, tokens, session } = harness();
		void context;
		const { secret } = tokens.create('ci', 'tenant-admin', 'acme');
		const resolved = principalFor(
			get('/api/status', {
				authorization: `Bearer ${secret}`,
				cookie: `${SESSION_COOKIE}=${session.id}`
			}),
			deps
		);
		expect(resolved?.credential).toBe('token');
	});

	it('answers null for a revoked token rather than falling back to the cookie', () => {
		const { deps, tokens, session } = harness();
		const { token, secret } = tokens.create('ci', 'tenant-admin', 'acme');
		tokens.revoke(token.id);
		const resolved = principalFor(
			get('/api/status', { authorization: `Bearer ${secret}` }),
			deps
		);
		expect(resolved).toBe(null);
		void session;
	});
});

describe('GET /api/session', () => {
	it('tells a caller who they are, so the dashboard can filter by principal', async () => {
		const { context, deps, session } = harness();
		const response = await handleApi(
			context,
			get('/api/session', { cookie: `${SESSION_COOKIE}=${session.id}` }),
			deps
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			result: { id: string; role: string; credential: string; csrf: string };
		};
		expect(body.result.id).toBe('op');
		expect(body.result.role).toBe('operator');
		expect(body.result.credential).toBe('session');
		expect(body.result.csrf).toBe(session.csrfToken);
	});

	it('answers 401 rather than an anonymous identity', async () => {
		const { context, deps } = harness();
		const response = await handleApi(context, get('/api/session'), deps);
		expect(response.status).toBe(401);
	});

	it('answers a token principal without a CSRF token, which only a session has', async () => {
		const { context, deps, tokens } = harness();
		const { secret } = tokens.create('ci', 'tenant-admin', 'acme');
		const response = await handleApi(
			context,
			get('/api/session', { authorization: `Bearer ${secret}` }),
			deps
		);
		const body = (await response.json()) as {
			result: { role: string; tenant: string; credential: string; csrf: string | null };
		};
		expect(body.result.credential).toBe('token');
		expect(body.result.tenant).toBe('acme');
		expect(body.result.csrf).toBe(null);
	});

	it('needs no handler, so a deployment cannot leave the dashboard unable to identify itself', async () => {
		const { context, deps, session } = harness({ handlers: {} });
		const response = await handleApi(
			context,
			get('/api/session', { cookie: `${SESSION_COOKIE}=${session.id}` }),
			deps
		);
		expect(response.status).toBe(200);
	});

	it('is still a 404 for a path that is not a route and is not identity', async () => {
		const { context, deps, session } = harness();
		const response = await handleApi(
			context,
			get('/api/nonsense', { cookie: `${SESSION_COOKIE}=${session.id}` }),
			deps
		);
		expect(response.status).toBe(404);
	});
});

/**
 * The claim exchange, which is how a browser gets a credential at all.
 *
 * Before this existed the dashboard could render and never sign in: `GET /api/session` answered
 * 401 forever, there was no route that minted a session, and the claim token `bastion dashboard
 * token` prints lived in the memory of the process that printed it.
 */
describe('POST /api/session', () => {
	const claimWith = (body: unknown, headers: Record<string, string> = {}) =>
		new Request(`${ORIGIN}${SESSION_PATH}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
			body: JSON.stringify(body)
		});

	it('exchanges a freshly minted claim for an operator session', async () => {
		const { context, deps, sessions } = harness();
		const claim = sessions.mintClaimToken();
		const response = await handleApi(context, claimWith({ claim }), deps);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { result: { role: string; csrf: string } };
		expect(body.result.role).toBe('operator');
		expect(body.result.csrf).toBeTruthy();
	});

	it('sets a __Host- cookie, which a browser keeps only over tls', async () => {
		const { context, deps, sessions } = harness();
		const response = await handleApi(
			context,
			claimWith({ claim: sessions.mintClaimToken() }),
			deps
		);
		const cookie = response.headers.get('set-cookie') ?? '';
		expect(cookie).toContain('__Host-bastion-session=');
		expect(cookie).toContain('Secure');
		expect(cookie).toContain('HttpOnly');
	});

	it('spends the claim, so the same one cannot be used twice', async () => {
		const { context, deps, sessions } = harness();
		const claim = sessions.mintClaimToken();
		expect((await handleApi(context, claimWith({ claim }), deps)).status).toBe(200);
		expect((await handleApi(context, claimWith({ claim }), deps)).status).toBe(401);
	});

	it('refuses a wrong claim and a missing one with the same words', async () => {
		const { context, deps, sessions } = harness();
		sessions.mintClaimToken();
		const wrong = await handleApi(context, claimWith({ claim: 'nope' }), deps);
		const missing = await handleApi(context, claimWith({}), deps);
		expect(wrong.status).toBe(401);
		expect(await wrong.text()).toBe(await missing.text());
	});

	it('refuses when no claim has been minted at all', async () => {
		const { context, deps } = harness();
		expect((await handleApi(context, claimWith({ claim: 'anything' }), deps)).status).toBe(401);
	});

	it('gives the session it minted, which the identity route then reads back', async () => {
		const { context, deps, sessions } = harness();
		const minted = await handleApi(
			context,
			claimWith({ claim: sessions.mintClaimToken() }),
			deps
		);
		const id = /__Host-bastion-session=([^;]+)/.exec(
			minted.headers.get('set-cookie') ?? ''
		)?.[1];
		const identity = await handleApi(
			context,
			get(SESSION_PATH, { cookie: `${SESSION_COOKIE}=${id as string}` }),
			deps
		);
		expect(identity.status).toBe(200);
		expect(JSON.stringify(await identity.json())).toContain('operator');
	});

	it('signs out, and the session stops working', async () => {
		const { context, deps, sessions } = harness();
		const minted = await handleApi(
			context,
			claimWith({ claim: sessions.mintClaimToken() }),
			deps
		);
		const id = /__Host-bastion-session=([^;]+)/.exec(
			minted.headers.get('set-cookie') ?? ''
		)?.[1];
		const cookie = { cookie: `${SESSION_COOKIE}=${id as string}` };

		const out = await handleApi(
			context,
			new Request(`${ORIGIN}${SESSION_PATH}`, { method: 'DELETE', headers: cookie }),
			deps
		);
		expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
		expect((await handleApi(context, get(SESSION_PATH, cookie), deps)).status).toBe(401);
	});
});
