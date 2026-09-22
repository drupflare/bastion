import { describe, expect, it } from 'vitest';
import { memoryAdapters } from '../../../src/adapters/build';
import { defaultConfig } from '../../../src/config/defaults';
import type { BastionConfig, SiteConfig } from '../../../src/config/types';
import { defaultContext } from '../../../src/context';
import { recordingListenerHost } from '../../../src/front/listener';
import { scriptedRunner } from '../../../src/host/exec';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import { cgroupPath } from '../../../src/isolation/cgroups';
import { Runtime } from '../../../src/serve/runtime';

/** an absolute path, because a relative one resolves against the process working directory */
const BUNDLE = '/srv/bundle';

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
				adapters: memoryAdapters,
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

	/**
	 * The supervisor's restart loop had no caller.
	 *
	 * `startTenant` called `start()`, which spawns once and returns, so `run()` -- the loop with the
	 * backoff, the jitter and the crash-loop breaker -- was dead code and `runtime.workerd_restart`
	 * and `runtime.crash_loop` could never fire. Measured in a container: `kill -9` the tenant's
	 * workerd and eight seconds later nothing was running and every request answered 502.
	 */
	/**
	 * A tenant that stays up.
	 *
	 * The scripted spawn resolves `exited` at once, so the loop reads a clean exit, resets the
	 * attempt count and clears the pid before an assertion can see any of it. A workerd that keeps
	 * running is what every one of these is about.
	 */
	function serving(mode: BastionConfig['mode'] = 'solo') {
		const made = runtimeFor(mode);
		const spawn = made.h.runner.spawn;
		made.h.runner.spawn = (command, args, options) => ({
			...spawn(command, args, options),
			exited: new Promise<number>(() => {})
		});
		return made;
	}

	/** the same, with a site, so the adapter sockets and the generated capnp are real */
	function servingSite() {
		const h = harness({
			state: '/var/lib/bastion',
			tenants: [{ name: 'acme', sites: [{ host: 'a.example.edu', bundle: BUNDLE }] }]
		});
		h.files.writeText(`${BUNDLE}/index.js`, 'export default {}');
		const spawn = h.runner.spawn;
		h.runner.spawn = (command, args, options) => ({
			...spawn(command, args, options),
			exited: new Promise<number>(() => {})
		});
		return {
			h,
			runtime: new Runtime(h.ctx, {
				config: h.config,
				host: h.host,
				upstream: h.upstream,
				binary: '/usr/local/bin/workerd',
				adapters: memoryAdapters,
				platform: 'linux'
			})
		};
	}

	it('drives the restart loop rather than spawning once and walking away', async () => {
		const { h, runtime } = serving();
		await runtime.startTenant('acme');
		expect(runtime.supervisorFor('acme')?.snapshot().state).toBe('running');
		expect(h.runner.calls.filter((call) => call.mode === 'spawn')).toHaveLength(1);
	});

	it('records the runtime pid, which is the only honest answer status can read', async () => {
		const { h, runtime } = serving();
		await runtime.startTenant('acme');
		expect(h.files.readText('/var/lib/bastion/tenants/acme/workerd.pid')).toBe('4242');
	});

	/**
	 * A swap is a process swap, because workerd has no in-place reload.
	 *
	 * What it buys over `restart` is the blast radius: the tenants that did not change keep their
	 * Durable Objects resident, which on a box holding a department's sites is the difference
	 * between one site blinking and all of them.
	 */
	it('starts the tenant again on the configuration now on disk', async () => {
		const { h, runtime } = serving();
		await runtime.startTenant('acme');
		const before = h.runner.calls.filter((call) => call.mode === 'spawn').length;
		await runtime.swapTenant('acme');
		expect(h.runner.calls.filter((call) => call.mode === 'spawn').length).toBe(before + 1);
		expect(runtime.supervisorFor('acme')?.snapshot().state).toBe('running');
	});

	it('takes the adapter sockets down with the old process and binds them again', async () => {
		const { h, runtime } = servingSite();
		await runtime.startTenant('acme');
		const bound = h.host.bound.length;
		await runtime.swapTenant('acme');
		expect(h.host.bound.length).toBeGreaterThan(bound);
		expect(h.host.stopped.length).toBeGreaterThan(0);
	});

	it('swaps only the tenant whose digest moved', async () => {
		const { h, runtime } = serving();
		await runtime.startTenant('acme');
		expect(await runtime.swapChanged()).toEqual([]);

		h.files.remove('/var/lib/bastion/tenants/acme/config.sha256');
		expect(await runtime.swapChanged()).toEqual(['acme']);
	});

	it('leaves a suspended tenant alone', async () => {
		const { h, runtime } = serving();
		await runtime.startTenant('acme');
		h.files.remove('/var/lib/bastion/tenants/acme/config.sha256');
		(h.config.tenants[0] as { suspended?: boolean }).suspended = true;
		expect(await runtime.swapChanged()).toEqual([]);
	});

	/**
	 * The CLI is a different process, so it asks through a file under `state`.
	 *
	 * A signal carries no payload and the management API needs a credential and a listener that may
	 * be the thing that is broken. The request is removed as it is picked up, so a crash mid-swap
	 * does not replay it forever.
	 */
	it('answers nothing when no reload was asked for', async () => {
		const { runtime } = serving();
		expect(await runtime.serveReloadRequest()).toBeNull();
	});

	it('performs the swap a request asks for and writes the outcome beside it', async () => {
		const { h, runtime } = serving();
		await runtime.startTenant('acme');
		h.files.remove('/var/lib/bastion/tenants/acme/config.sha256');
		h.files.writeText('/var/lib/bastion/reload.request', '{}');

		const outcome = await runtime.serveReloadRequest();
		expect(outcome?.swapped).toEqual(['acme']);
		expect(h.files.exists('/var/lib/bastion/reload.request')).toBe(false);
		expect(JSON.parse(h.files.readText('/var/lib/bastion/reload.outcome')).swapped).toEqual([
			'acme'
		]);
	});

	/** one tenant that will not come back must not take the others with it */
	it('names a tenant whose new configuration would not start, and carries on', async () => {
		const { h, runtime } = servingSite();
		await runtime.startTenant('acme');
		h.files.remove('/var/lib/bastion/tenants/acme/config.sha256');
		// the bundle the site names is gone, so regenerating its configuration refuses
		h.files.remove(`${BUNDLE}/index.js`);
		h.files.writeText('/var/lib/bastion/reload.request', '{}');

		const outcome = await runtime.serveReloadRequest();
		expect(outcome?.swapped).toEqual([]);
		expect(outcome?.failed[0]?.tenant).toBe('acme');
	});

	it('forgets that pid once the tenant stops, so nothing reads a dead one as alive', async () => {
		const { h, runtime } = runtimeFor('solo');
		await runtime.startTenant('acme');
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(h.files.exists('/var/lib/bastion/tenants/acme/workerd.pid')).toBe(false);
	});

	/** workerd refuses to bind over a socket the dead process still holds */
	it('clears the listen socket before the spawn, not once per startTenant', async () => {
		const { h, runtime } = runtimeFor('solo');
		h.files.writeText('/var/lib/bastion/tenants/acme/http.sock', '');
		await runtime.startTenant('acme');
		expect(h.files.exists('/var/lib/bastion/tenants/acme/http.sock')).toBe(false);
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
	/**
	 * The bundle goes where the SITE says it is.
	 *
	 * This once wrote it to `${state}/tenants/<name>/bundle`, which nothing populates, and the
	 * runtime read from there too, so both halves agreed on a directory that is empty on a real
	 * box. Every `bastion up` spawned a child that died on ENOENT while the parent reported a pid.
	 */
	function withSite(site: SiteConfig) {
		const h = harness({
			state: '/var/lib/bastion',
			tenants: [{ name: 'acme', sites: [site] }]
		});
		h.files.writeText(`${BUNDLE}/index.js`, 'export default {}');
		return {
			h,
			runtime: new Runtime(h.ctx, {
				config: h.config,
				host: h.host,
				upstream: h.upstream,
				binary: '/usr/local/bin/workerd',
				adapters: memoryAdapters,
				platform: 'linux'
			})
		};
	}

	const CAPNP = '/var/lib/bastion/tenants/acme/config.capnp';

	it('writes it before the process is spawned', async () => {
		const { h, runtime } = withSite({ host: 'api.example.edu', bundle: BUNDLE });
		await runtime.startTenant('acme');
		expect(h.files.exists(CAPNP)).toBe(true);
		expect(h.files.readText(CAPNP)).toContain('sockets = [');
	});

	it('generates an arbitrary worker with no object when the site says so', async () => {
		const { h, runtime } = withSite({
			host: 'api.example.edu',
			bundle: BUNDLE,
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
			bundle: BUNDLE,
			probe: 'drupflare'
		});
		await runtime.startTenant('acme');
		const config = h.files.readText(CAPNP);
		expect(config).toContain('className = "SitePhpDurableObject"');
		expect(config).toContain('kvNamespace');
	});

	it('takes the entrypoint from the bundle rather than from a fixed name', async () => {
		const { h, runtime } = withSite({ host: 'api.example.edu', bundle: BUNDLE });
		h.files.writeText(`${BUNDLE}/lib.wasm`, 'x');
		await runtime.startTenant('acme');
		const config = h.files.readText(CAPNP);
		expect(config.indexOf('index.js')).toBeLessThan(config.indexOf('lib.wasm'));
	});

	it('refuses a bundle with no entrypoint instead of writing an unstartable config', async () => {
		const { h, runtime } = withSite({ host: 'api.example.edu', bundle: BUNDLE });
		h.files.remove(`${BUNDLE}/index.js`);
		await expect(runtime.startTenant('acme')).rejects.toThrow(/no modules/);
	});
});

describe('Runtime.serve', () => {
	function serving() {
		const h = harness({
			tenants: [
				{
					name: 'acme',
					sites: [{ host: 'www.example.edu', bundle: BUNDLE, probe: 'drupflare' }]
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
	/** a keypair in the store, which is what an https listener needs before it may bind */
	function withCertificate(over: Partial<BastionConfig> = {}) {
		const h = harness({ tenants: [], ...over });
		const dir = `${h.config.state}/certs/www.example.edu`;
		h.files.writeText(`${dir}/key.pem`, 'KEY');
		h.files.writeText(`${dir}/fullchain.pem`, 'CERT');
		h.files.writeText(
			`${dir}/meta.json`,
			JSON.stringify({
				hosts: ['www.example.edu'],
				issuedAt: 0,
				expiresAt: 86_400_000,
				source: 'self-signed'
			})
		);
		return h;
	}

	it('binds both listeners and reports what it bound', async () => {
		const h = withCertificate();
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: h.upstream,
			platform: 'linux'
		});
		const state = await runtime.up();
		expect(state.listeners.map((l) => l.which)).toEqual(['http', 'https']);
	});

	/**
	 * An https listener with no keypair used to bind PLAINTEXT and report itself as https.
	 *
	 * A visitor typing the url got cleartext on the port that exists to encrypt it, and the
	 * operator read `https on 0.0.0.0:443` and believed otherwise. Nothing anywhere said so.
	 */
	it('refuses to bind https with no certificate rather than serving plaintext', async () => {
		const h = harness({ tenants: [] });
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: h.upstream,
			platform: 'linux'
		});
		await expect(runtime.up()).rejects.toThrow(/no certificate/);
	});

	it('names the command that produces one', async () => {
		const h = harness({ tenants: [] });
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: h.upstream,
			platform: 'linux'
		});
		await expect(runtime.up()).rejects.toMatchObject({ next: 'bastion cert issue' });
	});

	/**
	 * The refusal above fires after the tenants have already started, and they used to stay up.
	 *
	 * workerd kept its unix socket, so the parent could not exit, the startup grace read the live
	 * child as a healthy start and reported a pid, and the next `up` met `Address already in use`.
	 */
	function refusedStart() {
		const h = harness({ tenants: [{ name: 'acme', sites: [] }] });
		return {
			h,
			runtime: new Runtime(h.ctx, {
				config: h.config,
				host: h.host,
				upstream: h.upstream,
				binary: '/usr/local/bin/workerd',
				adapters: memoryAdapters,
				platform: 'linux'
			})
		};
	}

	it('takes the tenants back down when a listener refuses', async () => {
		const { runtime } = refusedStart();
		await expect(runtime.up()).rejects.toThrow(/no certificate/);
		expect(runtime.running).toEqual([]);
	});

	it('stops the listener it had already bound before the refusal', async () => {
		const { h, runtime } = refusedStart();
		await expect(runtime.up()).rejects.toThrow(/no certificate/);
		expect(h.host.stopped).toEqual([0]);
	});

	it('still binds http alone when no https listener is configured', async () => {
		const h = harness({ tenants: [], listeners: { ...defaultConfig().listeners } });
		delete (h.config.listeners as { https?: unknown }).https;
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: h.upstream,
			platform: 'linux'
		});
		const state = await runtime.up();
		expect(state.listeners.map((l) => l.which)).toEqual(['http']);
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
					sites: [{ host: 'www.example.edu', bundle: BUNDLE, probe: 'drupflare' }]
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
					sites: [{ host: 'www.example.edu', bundle: BUNDLE, probe: 'drupflare' }]
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
					sites: [{ host: 'www.example.edu', bundle: BUNDLE, probe: 'drupflare' }]
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

/**
 * What `up` has to put on disk before workerd will start.
 *
 * Each of these was found by booting a real workerd against a generated configuration, and each
 * was invisible to every hermetic test because the rig that passed happened to satisfy it.
 */
describe('Runtime.startTenant prepares the tenant directory', () => {
	const BUNDLE_DIR = '/srv/bundle';

	function ready(over: Partial<SiteConfig> = {}) {
		const h = harness({
			state: '/var/lib/bastion',
			tenants: [
				{ name: 'acme', sites: [{ host: 'a.example.edu', bundle: BUNDLE_DIR, ...over }] }
			]
		});
		h.files.writeText(`${BUNDLE_DIR}/index.js`, 'export default {}');
		return {
			h,
			runtime: new Runtime(h.ctx, {
				config: h.config,
				host: h.host,
				upstream: h.upstream,
				binary: '/usr/local/bin/workerd',
				adapters: memoryAdapters,
				platform: 'linux'
			})
		};
	}

	const TENANT = '/var/lib/bastion/tenants/acme';

	// `Directory named "bastion_storage" not found` -- workerd refuses a disk service whose
	// directory is absent and creates none of them itself
	it('creates the directories workerd refuses to start without', async () => {
		const { h, runtime } = ready();
		await runtime.startTenant('acme');
		for (const dir of ['storage', 'assets', 'adapters']) {
			expect(h.files.isDirectory(`${TENANT}/${dir}`)).toBe(true);
		}
	});

	/**
	 * A unix socket outlives the process that bound it.
	 *
	 * workerd answers `Address already in use` rather than replacing one, so a kill, an OOM or a
	 * power loss left a file that stopped the tenant ever starting again.
	 */
	it('removes a stale listen socket left by an unclean stop', async () => {
		const { h, runtime } = ready();
		h.files.writeText(`${TENANT}/http.sock`, '');
		await runtime.startTenant('acme');
		expect(h.files.exists(`${TENANT}/http.sock`)).toBe(false);
	});

	it('removes stale adapter sockets too', async () => {
		const { h, runtime } = ready();
		h.files.writeText(`${TENANT}/adapters/kv.sock`, '');
		h.files.writeText(`${TENANT}/adapters/cache.sock`, '');
		await runtime.startTenant('acme');
		expect(h.files.exists(`${TENANT}/adapters/kv.sock`)).toBe(false);
		expect(h.files.exists(`${TENANT}/adapters/cache.sock`)).toBe(false);
	});

	/** every unix address the generated config names under `adapters/`, in bind order */
	function adapterSockets(bound: { unix?: string }[]): string[] {
		return bound
			.map((spec) => spec.unix)
			.filter((path): path is string => path !== undefined && path.includes('/adapters/'));
	}

	/**
	 * The generator wrote the adapter addresses and nothing ever bound them.
	 *
	 * So the capnp declared `external` services at sockets that did not exist, workerd started
	 * anyway because it dials one lazily, and a bundle met a connection error on its first KV read,
	 * D1 query or Cache API lookup. A worker with no bindings served perfectly, which is what let
	 * it through: the tenant came up, answered a request, and the smoke assertion passed.
	 */
	it('binds a socket for every adapter address the generated config names', async () => {
		const { h, runtime } = ready({
			worker: { kv: ['KV'], d1: ['DB'], ai: ['AI'], main: 'index.js' }
		});
		await runtime.startTenant('acme');
		const capnp = h.files.readText(`${TENANT}/config.capnp`);
		const declared = [...capnp.matchAll(/unix:([^"]*\/adapters\/[^"]+)/g)].map((m) => m[1]);
		expect(declared.length).toBeGreaterThan(0);
		expect(adapterSockets(h.host.bound).sort()).toEqual([...new Set(declared)].sort());
	});

	// a tenant that beats its own adapters up answers its first request out of an error path
	it('binds them before the process that dials them is spawned', async () => {
		const { h, runtime } = ready();
		let boundAtSpawn = -1;
		const spawn = h.runner.spawn;
		h.runner.spawn = (command, args, options) => {
			boundAtSpawn = h.host.bound.length;
			return spawn(command, args, options);
		};
		await runtime.startTenant('acme');
		expect(boundAtSpawn).toBeGreaterThan(0);
		expect(boundAtSpawn).toBe(h.host.bound.length);
	});

	/**
	 * The slot is the SOCKET, never the path.
	 *
	 * workerd addresses an `external` service by its address and then sends whatever path the
	 * runtime generates, so a KV read arrives as `GET /<key>` with nothing naming the adapter. One
	 * shared socket made every native designator indistinguishable, and a handler routing on the
	 * first path segment answered a cache lookup out of the KV store.
	 */
	it('answers each socket out of the adapter that socket belongs to', async () => {
		const { h, runtime } = ready({ worker: { kv: ['KV'], main: 'index.js' } });
		await runtime.startTenant('acme');
		const at = adapterSockets(h.host.bound).findIndex((path) => path.endsWith('/kv.sock'));
		expect(at).toBeGreaterThanOrEqual(0);

		const handler =
			h.host.handlers[h.host.bound.findIndex((s) => s.unix?.endsWith('/kv.sock'))];
		await handler?.(new Request('http://unix/greeting', { method: 'PUT', body: 'hi' }), 'unix');
		const read = await handler?.(new Request('http://unix/greeting'), 'unix');
		expect(await read?.text()).toBe('hi');
	});

	/**
	 * Cap'n Proto resolves `embed` against the directory of the capnp holding it.
	 *
	 * An absolute path is refused outright, and a bare name only resolves when the config happens
	 * to sit beside the bundle. The generated config lives under the tenant state and the bundle
	 * lives wherever the operator put it, so the two are the same directory only by accident.
	 */
	it('writes embeds relative to the config rather than to the bundle', async () => {
		const { h, runtime } = ready();
		await runtime.startTenant('acme');
		const config = h.files.readText(`${TENANT}/config.capnp`);
		expect(config).toContain('embed "../../../../../srv/bundle/index.js"');
		expect(config).not.toContain('embed "/srv');
	});

	it('names the socket the front door dials, not a second name for the same file', async () => {
		const { h, runtime } = ready();
		await runtime.startTenant('acme');
		const config = h.files.readText(`${TENANT}/config.capnp`);
		expect(config).toContain(`unix:${TENANT}/http.sock`);
	});

	// a `worker` block naming a d1 or an ai binding validated, generated nothing, and the bundle
	// found the binding missing at runtime
	it('carries every binding slot the site declared, not the first five', async () => {
		const { h, runtime } = ready({
			worker: {
				durableObjectClass: null,
				d1: ['DB'],
				ai: ['AI'],
				vectorize: ['INDEX'],
				analytics: ['AE']
			}
		});
		await runtime.startTenant('acme');
		const config = h.files.readText(`${TENANT}/config.capnp`);
		for (const name of ['DB', 'AI', 'INDEX', 'AE']) {
			expect(config).toContain(`(name = "${name}", wrapped =`);
		}
	});

	it('refuses a site whose bundle is not there rather than generating a config for it', async () => {
		const h = harness({
			state: '/var/lib/bastion',
			tenants: [{ name: 'acme', sites: [{ host: 'a.example.edu', bundle: '/srv/absent' }] }]
		});
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: h.host,
			upstream: h.upstream,
			binary: '/usr/local/bin/workerd',
			adapters: memoryAdapters,
			platform: 'linux'
		});
		await expect(runtime.startTenant('acme')).rejects.toThrow(/has no bundle at/);
	});
});
