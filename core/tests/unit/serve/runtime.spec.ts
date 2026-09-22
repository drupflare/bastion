import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/defaults';
import type { BastionConfig, SiteConfig } from '../../../src/config/types';
import { defaultContext } from '../../../src/context';
import { recordingListenerHost } from '../../../src/front/listener';
import { scriptedRunner } from '../../../src/host/exec';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import { cgroupPath } from '../../../src/isolation/cgroups';
import { Runtime } from '../../../src/serve/runtime';

const LINUX = {
	'/sys/fs/cgroup/cgroup.controllers': 'cpu memory pids',
	'/proc/self/ns/net': '',
	'/sys/module/apparmor/parameters/enabled': 'Y',
	'/proc/self/status': 'Seccomp:\t2\n',
	'/dev/kvm': '',
	'/usr/bin/ip': '',
	'/usr/bin/aa-exec': '',
	'/usr/bin/systemd-run': ''
};

function harness(over: Partial<BastionConfig> = {}, seed: Record<string, string> = LINUX) {
	const config = { ...defaultConfig(), ...over };
	const files = memoryFiles(seed);
	const runner = scriptedRunner();
	const io = memoryIo();
	const ctx = {
		...defaultContext(),
		files,
		runner,
		io,
		env: { PATH: '/usr/bin' },
		now: () => 1000
	};
	const host = recordingListenerHost();
	const upstream = async () => new Response('ok');
	return { ctx, files, runner, io, host, config, upstream };
}

describe('Runtime.preflight', () => {
	it('refuses a mode this host cannot run rather than starting a weaker one', () => {
		const h = harness({ mode: 'isolated' }, {});
		// no mechanism files at all, so even on linux the mode is unavailable
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: h.upstream,
			platform: 'linux'
		});
		expect(() => runtime.preflight()).toThrow(/will not run a weaker mode/);
	});

	it('refuses two tenants in solo without the acknowledgement', () => {
		const h = harness({
			mode: 'solo',
			tenants: [
				{ name: 'a', sites: [] },
				{ name: 'b', sites: [] }
			]
		});
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: h.upstream,
			platform: 'linux'
		});
		expect(() => runtime.preflight()).toThrow(/not multi-tenant safe/);
	});

	it('accepts two tenants in solo once acknowledged, and still warns', () => {
		const h = harness({
			mode: 'solo',
			tenants: [
				{ name: 'a', sites: [] },
				{ name: 'b', sites: [] }
			]
		});
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: h.upstream,
			acknowledgeUnsafeMode: true,
			platform: 'linux'
		});
		expect(runtime.preflight().warnings[0]).toContain('not multi-tenant safe');
	});
});

describe('Runtime.startTenant', () => {
	function runtimeFor(mode: BastionConfig['mode']) {
		const h = harness({
			mode,
			tenants: [{ name: 'acme', sites: [], limits: { cpu: '2', memory: 4096 } }]
		});
		return {
			h,
			runtime: new Runtime(h.ctx, {
				config: h.config,
				host: h.host,
				upstream: h.upstream,
				binary: '/usr/local/bin/workerd',
				platform: 'linux'
			})
		};
	}

	it('creates the cgroup BEFORE the process, so the pid can be attached at once', async () => {
		const { h, runtime } = runtimeFor('solo');
		await runtime.startTenant('acme');
		expect(h.files.readText(`${cgroupPath('acme')}/memory.max`)).toBe('4096');
		expect(h.files.readText(`${cgroupPath('acme')}/cgroup.procs`)).toBe('4242');
	});

	it('wraps the process in hardened and leaves it bare in solo', async () => {
		const solo = runtimeFor('solo');
		await solo.runtime.startTenant('acme');
		expect(solo.h.runner.calls.find((c) => c.mode === 'spawn')?.command).toBe(
			'/usr/local/bin/workerd'
		);

		const hardened = runtimeFor('hardened');
		await hardened.runtime.startTenant('acme');
		expect(hardened.h.runner.calls.find((c) => c.mode === 'spawn')?.command).toBe(
			'systemd-run'
		);
	});

	it('creates the namespace and installs the profile only in hardened', async () => {
		const solo = runtimeFor('solo');
		await solo.runtime.startTenant('acme');
		expect(solo.h.runner.calls.map((c) => c.command)).not.toContain('ip');

		const hardened = runtimeFor('hardened');
		await hardened.runtime.startTenant('acme');
		const commands = hardened.h.runner.calls.map((c) => c.command);
		expect(commands).toContain('ip');
		expect(commands).toContain('apparmor_parser');
	});

	it('refuses a tenant that is not configured', async () => {
		const { runtime } = runtimeFor('solo');
		await expect(runtime.startTenant('ghost')).rejects.toThrow(/no tenant called/);
	});

	it('refuses to start anything with no workerd binary resolved', async () => {
		const h = harness({ tenants: [{ name: 'acme', sites: [] }] });
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: h.upstream,
			platform: 'linux'
		});
		await expect(runtime.startTenant('acme')).rejects.toThrow(/no workerd binary/);
	});
});

/**
 * The supervisor took a `configPath` from the first commit and nothing ever produced the file, so
 * `up` spawned workerd against a path that did not exist. These read the file off the seam.
 */
describe('Runtime.startTenant writes the config workerd is pointed at', () => {
	function withSite(site: SiteConfig) {
		const h = harness({
			state: '/var/lib/bastion',
			tenants: [{ name: 'acme', sites: [site] }]
		});
		h.files.writeText('/var/lib/bastion/tenants/acme/bundle/index.js', 'export default {}');
		return {
			h,
			runtime: new Runtime(h.ctx, {
				config: h.config,
				host: h.host,
				upstream: h.upstream,
				binary: '/usr/local/bin/workerd',
				platform: 'linux'
			})
		};
	}

	const CAPNP = '/var/lib/bastion/tenants/acme/config.capnp';

	it('writes it before the process is spawned', async () => {
		const { h, runtime } = withSite({ host: 'api.example.edu', bundle: './w' });
		await runtime.startTenant('acme');
		expect(h.files.exists(CAPNP)).toBe(true);
		expect(h.files.readText(CAPNP)).toContain('sockets = [');
	});

	it('generates an arbitrary worker with no object when the site says so', async () => {
		const { h, runtime } = withSite({
			host: 'api.example.edu',
			bundle: './w',
			worker: {
				durableObjectClass: null,
				durableObject: undefined,
				assets: undefined,
				kv: []
			}
		});
		await runtime.startTenant('acme');
		const config = h.files.readText(CAPNP);
		expect(config).not.toContain('durableObjectNamespaces');
		expect(config).toContain('cacheApiOutbound');
	});

	it('keeps the drupflare shape for a site that declares no worker block', async () => {
		const { h, runtime } = withSite({
			host: 'www.example.edu',
			bundle: './p',
			probe: 'drupflare'
		});
		await runtime.startTenant('acme');
		const config = h.files.readText(CAPNP);
		expect(config).toContain('className = "SitePhpDurableObject"');
		expect(config).toContain('kvNamespace');
	});

	it('takes the entrypoint from the bundle rather than from a fixed name', async () => {
		const { h, runtime } = withSite({ host: 'api.example.edu', bundle: './w' });
		h.files.writeText('/var/lib/bastion/tenants/acme/bundle/lib.wasm', 'x');
		await runtime.startTenant('acme');
		const config = h.files.readText(CAPNP);
		expect(config.indexOf('index.js')).toBeLessThan(config.indexOf('lib.wasm'));
	});

	it('refuses a bundle with no entrypoint instead of writing an unstartable config', async () => {
		const { h, runtime } = withSite({ host: 'api.example.edu', bundle: './w' });
		h.files.remove('/var/lib/bastion/tenants/acme/bundle/index.js');
		await expect(runtime.startTenant('acme')).rejects.toThrow(/no modules/);
	});
});

describe('Runtime.serve', () => {
	function serving() {
		const h = harness({
			tenants: [
				{
					name: 'acme',
					sites: [{ host: 'www.example.edu', bundle: './p', probe: 'drupflare' }]
				}
			]
		});
		const seen: Request[] = [];
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: async (_route, request) => {
				seen.push(request);
				return new Response('rendered');
			},
			platform: 'linux'
		});
		return { h, runtime, seen };
	}

	it('routes a request through the front door to the tenant', async () => {
		const { runtime, seen } = serving();
		const response = await runtime.serve(
			new Request('https://www.example.edu/node/1', { headers: { host: 'www.example.edu' } }),
			'203.0.113.7'
		);
		expect(response.status).toBe(200);
		expect(seen[0]?.headers.get('cf-connecting-ip')).toBe('203.0.113.7');
	});

	it('404s an unknown host without reaching a tenant', async () => {
		const { runtime, seen } = serving();
		const response = await runtime.serve(
			new Request('https://nope.example.edu/', { headers: { host: 'nope.example.edu' } }),
			'203.0.113.7'
		);
		expect(response.status).toBe(404);
		expect(seen).toHaveLength(0);
	});

	it('answers an ACME challenge from the front door rather than a second listener', async () => {
		const { runtime } = serving();
		await runtime.challengeResponder.publish('www.example.edu', 'TOKEN', 'TOKEN.thumb');
		const response = await runtime.serve(
			new Request('http://www.example.edu/.well-known/acme-challenge/TOKEN', {
				headers: { host: 'www.example.edu' }
			}),
			'203.0.113.7'
		);
		expect(await response.text()).toBe('TOKEN.thumb');
	});

	it('404s a challenge token it never published', async () => {
		const { runtime } = serving();
		const response = await runtime.serve(
			new Request('http://www.example.edu/.well-known/acme-challenge/OTHER', {
				headers: { host: 'www.example.edu' }
			}),
			'203.0.113.7'
		);
		expect(response.status).toBe(404);
	});
});

describe('Runtime.bind', () => {
	it('always asks for reusePort, so a rebind is seamless', async () => {
		const h = harness();
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: h.upstream,
			platform: 'linux'
		});
		await runtime.bind('https', [{ serverName: 'a', key: 'K', cert: 'C' }]);
		expect(h.host.bound[0]?.reusePort).toBe(true);
	});

	it('drains the old listener when it rebinds, rather than leaving two', async () => {
		const h = harness();
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: h.upstream,
			platform: 'linux'
		});
		await runtime.bind('https', []);
		await runtime.bind('https', [{ serverName: 'a', key: 'K', cert: 'C' }]);
		expect(h.host.bound).toHaveLength(2);
		expect(h.host.stopped).toEqual([0]);
	});
});

describe('Runtime.up and down', () => {
	it('binds both listeners and reports what it bound', async () => {
		const h = harness({ tenants: [] });
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: h.upstream,
			platform: 'linux'
		});
		const state = await runtime.up();
		expect(state.listeners.map((l) => l.which)).toEqual(['http', 'https']);
	});

	it('stops every listener and every tenant', async () => {
		const h = harness({ tenants: [] });
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: h.upstream,
			platform: 'linux'
		});
		await runtime.bind('https', []);
		await runtime.down();
		expect(h.host.stopped).toHaveLength(1);
		expect(runtime.running).toEqual([]);
	});
});

describe('Runtime.serveManagement', () => {
	it('answers 503 rather than serving unauthenticated when sessions are not configured', async () => {
		const h = harness();
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: h.upstream,
			platform: 'linux'
		});
		const response = await runtime.serveManagement(
			new Request('http://127.0.0.1:8787/api/status')
		);
		expect(response.status).toBe(503);
	});
});

describe('Runtime records what it served', () => {
	function serving() {
		const h = harness({
			tenants: [
				{
					name: 'acme',
					sites: [{ host: 'www.example.edu', bundle: './p', probe: 'drupflare' }]
				}
			]
		});
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: async () =>
				new Response('rendered', {
					headers: { 'content-length': '8', 'cf-cache-status': 'HIT' }
				}),
			platform: 'linux'
		});
		return { h, runtime };
	}

	it('records a served request rather than discarding the outcome', async () => {
		const { runtime } = serving();
		await runtime.serve(
			new Request('https://www.example.edu/', { headers: { host: 'www.example.edu' } }),
			'203.0.113.7'
		);
		const [summary] = runtime.analytics.summarise({ from: 0, to: Number.MAX_SAFE_INTEGER });
		expect(summary?.site).toBe('www.example.edu');
		expect(summary?.requests).toBe(1);
		expect(summary?.cachedFraction).toBe(1);
	});

	it('records a refusal as a refusal rather than as a site error', async () => {
		const h = harness({
			tenants: [
				{
					name: 'acme',
					sites: [{ host: 'www.example.edu', bundle: './p', probe: 'drupflare' }]
				}
			]
		});
		// the per-TENANT limit, which is refused after the route is known and so has a site
		h.config.front.rateLimit = { perIp: 1000, perTenant: 1 };
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: async () => new Response('ok'),
			platform: 'linux'
		});
		const request = () =>
			new Request('https://www.example.edu/', { headers: { host: 'www.example.edu' } });
		await runtime.serve(request(), '203.0.113.7');
		await runtime.serve(request(), '203.0.113.7');
		const [summary] = runtime.analytics.summarise({ from: 0, to: Number.MAX_SAFE_INTEGER });
		expect(summary?.refusals).toBe(1);
		expect(summary?.errors).toBe(0);
	});

	it('records nothing against a site for a request that never reached one', async () => {
		const { runtime } = serving();
		await runtime.serve(
			new Request('https://nope.example.edu/', { headers: { host: 'nope.example.edu' } }),
			'203.0.113.7'
		);
		expect(runtime.analytics.size).toBe(0);
	});

	it('counts a routeless refusal rather than losing it, because a flood of them matters', async () => {
		const { runtime } = serving();
		await runtime.serve(
			new Request('https://nope.example.edu/', { headers: { host: 'nope.example.edu' } }),
			'203.0.113.7'
		);
		expect(runtime.unattributed.get('no-route')).toBe(1);
	});

	it('counts a per-IP refusal, which is decided before there is a site to attribute it to', async () => {
		const h = harness({
			tenants: [
				{
					name: 'acme',
					sites: [{ host: 'www.example.edu', bundle: './p', probe: 'drupflare' }]
				}
			]
		});
		h.config.front.rateLimit = { perIp: 1, perTenant: 1000 };
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: async () => new Response('ok'),
			platform: 'linux'
		});
		const request = () =>
			new Request('https://www.example.edu/', { headers: { host: 'www.example.edu' } });
		await runtime.serve(request(), '203.0.113.7');
		await runtime.serve(request(), '203.0.113.7');
		expect(runtime.unattributed.get('rate-limit-ip')).toBe(1);
	});
});
