import { describe, expect, it } from 'vitest';
import { renderConfig } from '../../../src/capnp/generate';
import { ADAPTER_SERVICES, modulesFrom, planSite, type PlanInput } from '../../../src/capnp/plan';
import { resolveSiteWorker } from '../../../src/config/defaults';
import { memoryFiles } from '../../../src/host/files';

/**
 * bastion is a workerd host, not a drupflare host.
 *
 * Every assertion here is about a bundle that is not drupflare's: no Durable Object, no static
 * assets, no KV. The generator used to emit all three unconditionally, which meant an arbitrary
 * worker got a namespace naming a class its module does not export -- a config workerd refuses to
 * start, produced from a configuration that validated.
 */
const paths = {
	bundle: '/var/lib/bastion/t/acme/bundle',
	storage: '/var/lib/bastion/t/acme/storage',
	assets: '/var/lib/bastion/t/acme/assets',
	adapterDir: '/run/bastion/acme',
	listenSocket: '/run/bastion/acme-http.sock'
};

function plain(overrides: Partial<PlanInput> = {}): string {
	const input: PlanInput = {
		tenant: { name: 'acme', sites: [] },
		site: { host: 'api.example.edu', bundle: 'worker.tar.gz' },
		paths,
		modules: [{ name: 'index.js', kind: 'esModule', embed: 'index.js' }],
		compatibilityDate: '2026-08-01',
		compatibilityFlags: ['nodejs_compat'],
		uniqueKey: 'acme:api.example.edu',
		residency: 'evict',
		bindings: {},
		vars: {},
		...overrides
	};
	return renderConfig(planSite(input));
}

describe('a worker with no durable object', () => {
	it('declares no namespace, so workerd is never asked for a class the bundle lacks', () => {
		const config = plain();
		expect(config).not.toContain('durableObjectNamespaces');
		expect(config).not.toContain('className');
	});

	it('declares no durable object storage either', () => {
		expect(plain()).not.toContain('durableObjectStorage');
	});

	it('gives the storage disk no service, since nothing would mount it', () => {
		expect(plain()).not.toContain(ADAPTER_SERVICES.storage);
	});

	it('still pins the cache, which is mandatory whatever the bundle is', () => {
		expect(plain()).toContain(`cacheApiOutbound = "${ADAPTER_SERVICES.cache}"`);
	});

	it('still denies egress by default', () => {
		expect(plain()).toContain(`globalOutbound = "${ADAPTER_SERVICES.outbound}"`);
	});

	it('serves it on the tenant socket like any other site', () => {
		expect(plain()).toContain(`unix:${paths.listenSocket}`);
	});
});

describe('adapter slots a bundle does not ask for', () => {
	it('emits no assets binding and no assets service', () => {
		const config = plain();
		expect(config).not.toContain('ASSETS');
		expect(config).not.toContain(ADAPTER_SERVICES.assets);
	});

	it('emits no kv, r2 or queue service when none is bound', () => {
		const config = plain();
		expect(config).not.toContain(ADAPTER_SERVICES.kv);
		expect(config).not.toContain(ADAPTER_SERVICES.r2);
		expect(config).not.toContain(ADAPTER_SERVICES.queues);
	});

	it('emits exactly the slots the bundle names', () => {
		const config = plain({ bindings: { kv: ['SESSIONS'], queues: ['JOBS'] } });
		expect(config).toContain(`(name = "SESSIONS", kvNamespace = "${ADAPTER_SERVICES.kv}")`);
		expect(config).toContain(`(name = "JOBS", queue = "${ADAPTER_SERVICES.queues}")`);
		expect(config).not.toContain(ADAPTER_SERVICES.r2);
	});

	it('carries plain vars for a worker that wants only configuration', () => {
		expect(plain({ vars: { STAGE: 'prod' } })).toContain('(name = "STAGE", text = "prod")');
	});
});

describe('a worker that does want an object', () => {
	it('gets the namespace once both halves are stated', () => {
		const config = plain({
			durableObjectClass: 'Counter',
			bindings: { durableObject: 'COUNTER' }
		});
		expect(config).toContain('className = "Counter"');
		expect(config).toContain('enableSql = true');
		expect(config).toContain(
			`durableObjectStorage = (localDisk = "${ADAPTER_SERVICES.storage}")`
		);
	});

	it('stays evicting unless the site pins it', () => {
		const pinned = plain({
			durableObjectClass: 'Counter',
			bindings: { durableObject: 'COUNTER' },
			residency: 'pin'
		});
		expect(pinned).toContain('preventEviction = true');
	});
});

describe('the default site shape', () => {
	it('is drupflare, so a site that states nothing keeps working', () => {
		const resolved = resolveSiteWorker();
		expect(resolved.durableObjectClass).toBe('SitePhpDurableObject');
		expect(resolved.assets).toBe('ASSETS');
		expect(resolved.kv).toEqual(['CONFIG_KV', 'PAGE_KV']);
	});

	it('is overridden field by field rather than all or nothing', () => {
		const resolved = resolveSiteWorker({ durableObjectClass: null, assets: undefined });
		expect(resolved.durableObjectClass).toBeNull();
		expect(resolved.kv).toEqual(['CONFIG_KV', 'PAGE_KV']);
	});
});

describe('reading a bundle into a module list', () => {
	const files = (names: string[]) =>
		memoryFiles(Object.fromEntries(names.map((name) => [`${paths.bundle}/${name}`, 'x'])));
	const ctx = (names: string[]) => ({ files: files(names) }) as never;

	it('puts the entrypoint first, whatever the directory order is', () => {
		const modules = modulesFrom(ctx(['zebra.wasm', 'index.js']), paths.bundle);
		expect(modules[0]).toEqual({ name: 'index.js', kind: 'esModule', embed: 'index.js' });
	});

	it('maps each extension to the kind workerd expects', () => {
		const modules = modulesFrom(ctx(['index.js', 'php.wasm', 'notes.txt']), paths.bundle);
		// the entrypoint leads and the rest sort by name, so two runs over one bundle agree
		expect(modules.map((m) => [m.name, m.kind])).toEqual([
			['index.js', 'esModule'],
			['notes.txt', 'text'],
			['php.wasm', 'wasm']
		]);
	});

	it('takes the only script when the bundle names none conventionally', () => {
		expect(modulesFrom(ctx(['server.js']), paths.bundle)[0]?.name).toBe('server.js');
	});

	it('takes the stated entrypoint over the conventional one', () => {
		const modules = modulesFrom(ctx(['index.js', 'other.js']), paths.bundle, 'other.js');
		expect(modules[0]?.name).toBe('other.js');
	});

	it('refuses to guess between scripts rather than deploying the wrong module', () => {
		expect(() => modulesFrom(ctx(['a.js', 'b.js']), paths.bundle)).toThrow(/none is named/);
	});

	it('refuses a bundle with no javascript', () => {
		expect(() => modulesFrom(ctx(['php.wasm']), paths.bundle)).toThrow(/no javascript/);
	});

	it('refuses an empty bundle', () => {
		expect(() => modulesFrom(ctx([]), paths.bundle)).toThrow(/no modules/);
	});

	it('refuses a stated entrypoint the bundle does not hold', () => {
		expect(() => modulesFrom(ctx(['index.js']), paths.bundle, 'missing.js')).toThrow(
			/no module called missing.js/
		);
	});

	it('ignores files workerd has no module kind for', () => {
		const modules = modulesFrom(ctx(['index.js', 'README.md']), paths.bundle);
		expect(modules.map((m) => m.name)).toEqual(['index.js']);
	});
});
