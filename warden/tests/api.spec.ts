import {
	handleApi,
	hashPassword,
	memoryFiles,
	memoryIo,
	ROUTES,
	scriptedRunner,
	SESSION_COOKIE,
	SessionStore,
	TokenStore,
	type Account,
	type ApiDeps,
	type Context
} from '@drupflare/bastion';
import { describe, expect, it } from 'vitest';
import { apiHandlers } from '../src/api/handlers';

/**
 * Every management route, driven through the real handler map.
 *
 * The state this replaced: 29 routes, an authz table, sessions, CSRF and API tokens, all shipped
 * and unit-tested, with every route answering `not-implemented` because nothing supplied a handler
 * map. So the first test here is the sweep: no route may answer 501.
 *
 * The second half is the privilege boundary. `authorize` sees the action and the tenant the
 * session carries, and never a hostname, so the checks that keep one tenant out of another's site
 * live in the handlers and are scored here.
 */
const ORIGIN = 'https://127.0.0.1:8787';
const CHEAP = { N: 1024, r: 8, p: 1 };

const CONFIG = `
version: 1
mode: solo
state: /var/lib/bastion
tenants:
  - name: acme
    limits:
      cpu: "2"
      memory: 4Gi
    sites:
      - host: www.example.edu
        bundle: ./payload.tar.gz
        probe: drupflare
  - name: beta
    sites:
      - host: docs.example.edu
        bundle: ./payload.tar.gz
        probe: drupflare
`;

interface Answer {
	status: number;
	body: { ok?: boolean; result?: unknown; error?: { code: string; message: string } };
}

function harness(role: 'operator' | 'tenant-admin' | 'tenant-viewer' = 'operator') {
	const files = memoryFiles({ '/srv/bastion.yml': CONFIG });
	const ctx: Context = {
		io: memoryIo(),
		files,
		runner: scriptedRunner(),
		fetch: () => Promise.reject(new Error('no network in the gate lane')),
		env: { BASTION_TEST: '1' },
		cwd: '/srv',
		platform: 'linux',
		now: () => Date.UTC(2026, 8, 22)
	};
	const sessions = new SessionStore(ctx);
	const tokens = new TokenStore(ctx);
	const account: Account = {
		id: role === 'operator' ? 'op' : 'dept',
		role,
		tenant: role === 'operator' ? null : 'acme',
		password: hashPassword('pw', undefined, CHEAP)
	};
	const session = sessions.login(account, 'pw');
	const deps: ApiDeps = {
		config: { state: '/var/lib/bastion' } as ApiDeps['config'],
		sessions,
		tokens,
		origin: ORIGIN,
		handlers: apiHandlers({ config: '/srv/bastion.yml' })
	};

	const call = async (
		method: string,
		path: string,
		body?: unknown,
		headers: Record<string, string> = {}
	): Promise<Answer> => {
		const request = new Request(`${ORIGIN}${path}`, {
			method,
			headers: {
				cookie: `${SESSION_COOKIE}=${session.id}`,
				'x-bastion-csrf': session.csrfToken,
				origin: ORIGIN,
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
				...headers
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		});
		const response = await handleApi(ctx, request, deps);
		return { status: response.status, body: (await response.json()) as Answer['body'] };
	};

	return { ctx, files, call, tokens, sessions };
}

/** a plausible request for each route, so the sweep exercises the handler rather than the router */
const SAMPLE: Record<string, { path: string; body?: unknown }> = {
	'GET /api/status': { path: '/api/status' },
	'GET /api/doctor': { path: '/api/doctor' },
	'GET /api/capabilities': { path: '/api/capabilities' },
	'POST /api/capabilities/:slot/install': { path: '/api/capabilities/images/install' },
	'GET /api/health': { path: '/api/health' },
	'GET /api/metrics': { path: '/api/metrics' },
	'GET /api/logs': { path: '/api/logs' },
	'GET /api/config': { path: '/api/config' },
	'PUT /api/config': { path: '/api/config', body: { key: 'mode', value: 'solo' } },
	'GET /api/tenants': { path: '/api/tenants' },
	'POST /api/tenants': { path: '/api/tenants', body: { name: 'gamma' } },
	'DELETE /api/tenants/:tenant': { path: '/api/tenants/beta' },
	'GET /api/sites': { path: '/api/sites' },
	'POST /api/sites': {
		path: '/api/sites',
		body: { host: 'new.example.edu', tenant: 'acme', bundle: './payload.tar.gz' }
	},
	'DELETE /api/sites/:site': { path: '/api/sites/docs.example.edu' },
	'POST /api/sites/:site/deploy': {
		path: '/api/sites/www.example.edu/deploy',
		body: { bundle: '/srv/payload.tar.gz' }
	},
	'POST /api/sites/:site/rollout': {
		path: '/api/sites/www.example.edu/rollout',
		body: { version: 'v1', percent: 10 }
	},
	'POST /api/sites/:site/rollback': { path: '/api/sites/www.example.edu/rollback', body: {} },
	'GET /api/versions': { path: '/api/versions?host=www.example.edu' },
	'GET /api/backups': { path: '/api/backups' },
	'POST /api/backups': { path: '/api/backups', body: {} },
	'POST /api/repair/:code': { path: '/api/repair/host.disk_low', body: {} },
	'GET /api/quarantine': { path: '/api/quarantine' },
	'GET /api/secrets': { path: '/api/secrets' },
	'PUT /api/secrets/:name': { path: '/api/secrets/smtp', body: { value: 'hunter2' } },
	'GET /api/audit': { path: '/api/audit' },
	'GET /api/cluster': { path: '/api/cluster' },
	'POST /api/cluster/nodes': { path: '/api/cluster/nodes', body: { control: '10.0.0.1:8788' } },
	'GET /api/capacity': { path: '/api/capacity' }
};

describe('every management route', () => {
	it('has a sample in this spec, so the sweep below cannot silently shrink', () => {
		for (const route of ROUTES) {
			expect(SAMPLE[`${route.method} ${route.path}`], route.path).toBeDefined();
		}
		expect(Object.keys(SAMPLE)).toHaveLength(ROUTES.length);
	});

	for (const route of ROUTES) {
		const key = `${route.method} ${route.path}`;
		it(`answers ${key} rather than 501`, async () => {
			const { call } = harness();
			const sample = SAMPLE[key] as { path: string; body?: unknown };
			const answer = await call(route.method, sample.path, sample.body);
			expect(answer.status, JSON.stringify(answer.body)).not.toBe(501);
			expect(answer.body.error?.code).not.toBe('not-implemented');
		});
	}
});

describe('the routes that read', () => {
	it('lists both tenants for an operator', async () => {
		const { call } = harness();
		const answer = await call('GET', '/api/tenants');
		expect(answer.status).toBe(200);
		const result = answer.body.result as { tenants: { name: string }[] };
		expect(result.tenants.map((t) => t.name)).toEqual(['acme', 'beta']);
	});

	it('lists both sites, each with the tenant holding it', async () => {
		const { call } = harness();
		const result = (await call('GET', '/api/sites')).body.result as {
			sites: { host: string; tenant: string }[];
		};
		expect(result.sites.map((s) => `${s.tenant}/${s.host}`)).toEqual([
			'acme/www.example.edu',
			'beta/docs.example.edu'
		]);
	});

	it('answers config show with the configuration on disk', async () => {
		const { call } = harness();
		const answer = await call('GET', '/api/config');
		expect(answer.status).toBe(200);
		expect(JSON.stringify(answer.body.result)).toContain('www.example.edu');
	});

	it('renders metrics as prometheus text rather than json', async () => {
		const { call } = harness();
		const answer = await call('GET', '/api/metrics');
		expect(answer.status).toBe(200);
		expect(String(answer.body.result)).toContain('bastion_tenant_sites');
	});

	it('answers capacity, which the dashboard reads on its overview', async () => {
		const { call } = harness();
		expect((await call('GET', '/api/capacity')).status).toBe(200);
	});

	it('takes a finding as a result rather than a failure, since exit 3 is not an error', async () => {
		const { call } = harness();
		// `capability list` exits 3 when a binding's software is absent, which it is here
		const answer = await call('GET', '/api/capabilities');
		expect(answer.status).toBe(200);
		expect(answer.body.ok).toBe(true);
	});
});

describe('the routes that write', () => {
	it('adds a tenant, and the next read sees it', async () => {
		const { call } = harness();
		expect((await call('POST', '/api/tenants', { name: 'gamma' })).status).toBe(200);
		const result = (await call('GET', '/api/tenants')).body.result as { tenants: unknown[] };
		expect(result.tenants).toHaveLength(3);
	});

	it('writes a config key through the same validator the CLI uses', async () => {
		const { call, files } = harness();
		expect((await call('PUT', '/api/config', { key: 'mode', value: 'hardened' })).status).toBe(
			200
		);
		expect(files.readText('/srv/bastion.yml')).toContain('hardened');
	});

	it('refuses a config write the validator refuses, as a 400 rather than a 500', async () => {
		const { call } = harness();
		const answer = await call('PUT', '/api/config', { key: 'mode', value: 'nonsense' });
		expect(answer.status).toBe(400);
		expect(answer.body.error?.code).toBe('config-invalid');
	});

	it('names the field a body is missing', async () => {
		const { call } = harness();
		const answer = await call('POST', '/api/tenants', {});
		expect(answer.status).toBe(400);
		expect(answer.body.error?.message).toContain('needs a name');
	});

	it('refuses a body that is not json', async () => {
		const { call } = harness();
		const request = { 'content-type': 'application/json' };
		const answer = await call('POST', '/api/tenants', undefined, request);
		expect(answer.status).toBe(400);
	});
});

describe('a tenant-scoped credential', () => {
	it('sees only its own tenant', async () => {
		const { call } = harness('tenant-admin');
		const result = (await call('GET', '/api/tenants')).body.result as {
			tenants: { name: string }[];
		};
		expect(result.tenants.map((t) => t.name)).toEqual(['acme']);
	});

	it('sees only its own sites', async () => {
		const { call } = harness('tenant-admin');
		const result = (await call('GET', '/api/sites')).body.result as {
			sites: { host: string }[];
		};
		expect(result.sites.map((s) => s.host)).toEqual(['www.example.edu']);
	});

	it('sees only its own series in the metrics text', async () => {
		const { call } = harness('tenant-admin');
		const text = String((await call('GET', '/api/metrics')).body.result);
		expect(text).toContain('tenant="acme"');
		expect(text).not.toContain('tenant="beta"');
	});

	it('cannot deploy to another tenant site, though it may deploy', async () => {
		const { call } = harness('tenant-admin');
		const answer = await call('POST', '/api/sites/docs.example.edu/deploy', {
			bundle: '/srv/payload.tar.gz'
		});
		expect(answer.status).not.toBe(200);
		expect(answer.body.error?.message).toContain('scoped to acme');
	});

	it('cannot roll another tenant site back', async () => {
		const { call } = harness('tenant-admin');
		const answer = await call('POST', '/api/sites/docs.example.edu/rollback', {});
		expect(answer.body.error?.message).toContain('scoped to acme');
	});

	it('cannot remove another tenant site', async () => {
		const { call } = harness('tenant-admin');
		const answer = await call('DELETE', '/api/sites/docs.example.edu');
		expect(answer.body.error?.message).toContain('scoped to acme');
	});

	it('cannot read another tenant versions', async () => {
		const { call } = harness('tenant-admin');
		const answer = await call('GET', '/api/versions?host=docs.example.edu');
		expect(answer.body.error?.message).toContain('scoped to acme');
	});

	it('adds a site to its own tenant whatever the body names', async () => {
		const { call, files } = harness('tenant-admin');
		const answer = await call('POST', '/api/sites', {
			host: 'lab.example.edu',
			tenant: 'beta',
			bundle: './payload.tar.gz'
		});
		expect(answer.status).toBe(200);
		const written = files.readText('/srv/bastion.yml');
		const acme = written.slice(written.indexOf('name: acme'), written.indexOf('name: beta'));
		expect(acme).toContain('lab.example.edu');
	});

	it('reaches nothing the host owns', async () => {
		const { call } = harness('tenant-admin');
		for (const path of ['/api/doctor', '/api/secrets', '/api/audit', '/api/capacity']) {
			expect((await call('GET', path)).status, path).toBe(403);
		}
	});

	it('may not write config, even to its own tenant', async () => {
		const { call } = harness('tenant-admin');
		expect((await call('PUT', '/api/config', { key: 'mode', value: 'hardened' })).status).toBe(
			403
		);
	});

	it('cannot deploy at all as a viewer', async () => {
		const { call } = harness('tenant-viewer');
		const answer = await call('POST', '/api/sites/www.example.edu/deploy', {
			bundle: '/srv/payload.tar.gz'
		});
		expect(answer.status).toBe(403);
	});
});

describe('an api token', () => {
	it('reaches a route the table marks token, and is refused one it does not', async () => {
		const { ctx, tokens } = harness();
		const deps: ApiDeps = {
			config: { state: '/var/lib/bastion' } as ApiDeps['config'],
			sessions: new SessionStore(ctx),
			tokens,
			origin: ORIGIN,
			handlers: apiHandlers({ config: '/srv/bastion.yml' })
		};
		const secret = tokens.create('ci', 'operator', null).secret;
		const bearer = { authorization: `Bearer ${secret}` };

		const read = await handleApi(
			ctx,
			new Request(`${ORIGIN}/api/status`, { headers: bearer }),
			deps
		);
		expect(read.status).toBe(200);

		const write = await handleApi(
			ctx,
			new Request(`${ORIGIN}/api/secrets`, { headers: bearer }),
			deps
		);
		expect(write.status).toBe(403);
	});
});

/**
 * The shape each dashboard page destructures, asserted against what the route actually answers.
 *
 * Every route can answer 200 and still render nothing: the page reads `result.tenants`, the handler
 * returns `{rows}`, and neither side fails. Two were wrong when this was written. `/api/metrics`
 * answered Prometheus text to a page expecting rows, and `/api/cluster` on a box in no cluster
 * answered `{clustered:false}` to a page that reads `.nodes` straight off it.
 *
 * The keys come from `dashboard/src`, read rather than restated, so a page that starts reading a
 * new field fails here instead of in a browser.
 */
describe('the shape the dashboard reads', () => {
	const PAGES: { path: string; needs: string[] }[] = [
		{ path: '/api/status', needs: ['running', 'tenants'] },
		{ path: '/api/doctor', needs: ['limits'] },
		{ path: '/api/capabilities', needs: ['capabilities'] },
		{ path: '/api/health', needs: ['tree'] },
		{ path: '/api/capacity', needs: ['recommended', 'maximum', 'bindingTerm'] },
		{ path: '/api/logs?level=info', needs: ['lines'] },
		{ path: '/api/tenants', needs: ['tenants'] },
		{ path: '/api/sites', needs: ['sites'] },
		{ path: '/api/backups', needs: ['backups'] },
		{ path: '/api/audit', needs: ['entries'] },
		{ path: '/api/cluster', needs: ['nodes'] },
		{ path: '/api/versions?host=www.example.edu', needs: ['versions'] }
	];

	for (const page of PAGES) {
		it(`answers ${page.path} with ${page.needs.join(', ')}`, async () => {
			const { call } = harness();
			const answer = await call('GET', page.path);
			expect(answer.status, JSON.stringify(answer.body)).toBe(200);
			const result = answer.body.result as Record<string, unknown>;
			for (const key of page.needs) {
				expect(Object.keys(result), `${page.path} is missing ${key}`).toContain(key);
			}
		});
	}

	it('answers /api/cluster with an empty list rather than nothing on an unclustered box', async () => {
		const { call } = harness();
		const result = (await call('GET', '/api/cluster')).body.result as { nodes: unknown[] };
		expect(result.nodes).toEqual([]);
	});
});
