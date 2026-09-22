import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/defaults';
import { CLIENT_IP_HEADER } from '../../../src/front/client-ip';
import { handleRequest, limitBody, type FrontDeps } from '../../../src/front/handler';
import { ConnectionCounter, RateLimiter } from '../../../src/front/ratelimit';
import { routeTable, type Route } from '../../../src/front/router';

function deps(overrides: Partial<FrontDeps> = {}): FrontDeps & { seen: Request[] } {
	const config = defaultConfig();
	config.tenants = [
		{
			name: 'acme',
			sites: [{ host: 'www.example.edu', bundle: './p.tar.gz', probe: 'drupflare' }]
		}
	];
	const seen: Request[] = [];
	return {
		seen,
		table: routeTable(config),
		trust: { trustedProxies: [] },
		perIp: new RateLimiter({ rate: 1000, burst: 1000 }),
		perTenant: new RateLimiter({ rate: 1000, burst: 1000 }),
		connections: new ConnectionCounter(64),
		compression: { encodings: ['br', 'gzip'], minBytes: 1024 },
		maxBodyBytes: 1024,
		now: () => 0,
		upstream: async (_route: Route, request: Request) => {
			seen.push(request);
			return new Response('ok', { headers: { 'content-type': 'text/plain' } });
		},
		...overrides
	};
}

function get(path = '/', init: RequestInit = {}): Request {
	return new Request(`https://www.example.edu${path}`, {
		...init,
		headers: { host: 'www.example.edu', ...((init.headers as Record<string, string>) ?? {}) }
	});
}

describe('handleRequest', () => {
	it('serves a routed request from the tenant upstream', async () => {
		const d = deps();
		const outcome = await handleRequest(get(), '203.0.113.7', d);
		expect(outcome.response.status).toBe(200);
		expect(outcome.route?.tenant).toBe('acme');
		expect(outcome.refusal).toBe(null);
	});

	it('overwrites a client-supplied CF-Connecting-IP with the peer', async () => {
		const d = deps();
		await handleRequest(
			get('/', { headers: { [CLIENT_IP_HEADER]: '1.2.3.4' } }),
			'203.0.113.7',
			d
		);
		expect(d.seen[0]?.headers.get(CLIENT_IP_HEADER)).toBe('203.0.113.7');
	});

	it('forwards the Host byte-identical, because Drupal derives its cookie name from it', async () => {
		const d = deps();
		await handleRequest(get(), '203.0.113.7', d);
		expect(d.seen[0]?.headers.get('host')).toBe('www.example.edu');
	});

	it('refuses past the per-IP rate and names how long to wait', async () => {
		const d = deps({ perIp: new RateLimiter({ rate: 1, burst: 1 }) });
		await handleRequest(get(), '203.0.113.7', d);
		const outcome = await handleRequest(get(), '203.0.113.7', d);
		expect(outcome.response.status).toBe(429);
		expect(outcome.response.headers.get('retry-after')).toBe('1');
		expect(outcome.refusal).toBe('rate-limit-ip');
	});

	it('rate limits per IP before routing, so an unknown host is not a free probe', async () => {
		const d = deps({ perIp: new RateLimiter({ rate: 1, burst: 1 }) });
		await handleRequest(
			new Request('https://nope.example.edu/', { headers: { host: 'nope.example.edu' } }),
			'203.0.113.7',
			d
		);
		const outcome = await handleRequest(get(), '203.0.113.7', d);
		expect(outcome.response.status).toBe(429);
	});

	it('refuses past the per-tenant rate even when each address is within its own', async () => {
		const d = deps({ perTenant: new RateLimiter({ rate: 1, burst: 1 }) });
		await handleRequest(get(), '203.0.113.7', d);
		const outcome = await handleRequest(get(), '203.0.113.8', d);
		expect(outcome.response.status).toBe(429);
		expect(outcome.refusal).toBe('rate-limit-tenant');
	});

	it('404s an unknown host without reaching any tenant', async () => {
		const d = deps();
		const outcome = await handleRequest(
			new Request('https://nope.example.edu/', { headers: { host: 'nope.example.edu' } }),
			'203.0.113.7',
			d
		);
		expect(outcome.response.status).toBe(404);
		expect(d.seen).toHaveLength(0);
	});

	it('refuses a declared body over the cap before the upstream is called', async () => {
		const d = deps();
		const outcome = await handleRequest(
			get('/', { method: 'POST', headers: { 'content-length': '99999' }, body: 'x' }),
			'203.0.113.7',
			d
		);
		expect(outcome.response.status).toBe(413);
		expect(d.seen).toHaveLength(0);
	});

	it('answers 502 rather than a stack when the tenant is not up', async () => {
		const d = deps({
			upstream: async () => {
				throw new Error('ECONNREFUSED');
			}
		});
		const outcome = await handleRequest(get(), '203.0.113.7', d);
		expect(outcome.response.status).toBe(502);
		expect(outcome.refusal).toBe('upstream-unreachable');
	});

	it('compresses a large html response and marks it varying', async () => {
		const body = '<p>hello</p>'.repeat(400);
		const d = deps({
			upstream: async () => new Response(body, { headers: { 'content-type': 'text/html' } })
		});
		const outcome = await handleRequest(
			get('/', { headers: { 'accept-encoding': 'gzip' } }),
			'203.0.113.7',
			d
		);
		expect(outcome.response.headers.get('content-encoding')).toBe('gzip');
		expect(outcome.response.headers.get('vary')).toContain('accept-encoding');
	});

	it('leaves an already encoded response alone', async () => {
		const d = deps({
			upstream: async () =>
				new Response('x'.repeat(4000), {
					headers: { 'content-type': 'text/html', 'content-encoding': 'br' }
				})
		});
		const outcome = await handleRequest(
			get('/', { headers: { 'accept-encoding': 'gzip' } }),
			'203.0.113.7',
			d
		);
		expect(outcome.response.headers.get('content-encoding')).toBe('br');
	});

	it('sets HSTS only on a listener that asked for it', async () => {
		const plain = await handleRequest(get(), '203.0.113.7', deps());
		expect(plain.response.headers.get('strict-transport-security')).toBe(null);
		const secure = await handleRequest(get(), '203.0.113.7', deps({ hsts: true }));
		expect(secure.response.headers.get('strict-transport-security')).toContain('max-age=');
	});
});

describe('limitBody', () => {
	it('passes a body under the cap through unchanged', async () => {
		const source = new Response('hello').body as ReadableStream<Uint8Array>;
		const limited = new Response(limitBody(source, 1024));
		expect(await limited.text()).toBe('hello');
	});

	it('errors rather than truncating past the cap', async () => {
		const source = new Response('x'.repeat(100)).body as ReadableStream<Uint8Array>;
		const limited = new Response(limitBody(source, 10));
		await expect(limited.text()).rejects.toThrow();
	});
});
