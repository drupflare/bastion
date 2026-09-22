import { describe, expect, it } from 'vitest';
import { renderConfig } from '../../../src/capnp/generate';
import { ADAPTER_SERVICES, planSite, type PlanInput } from '../../../src/capnp/plan';
import { AI_SHIM, D1_SHIM, SHIM_MODULES } from '../../../src/capnp/shims';

/**
 * D1 and Workers AI, built out of the one binding workerd does carry.
 *
 * Neither has a field in `workerd.capnp` -- verified against the schema on main, where the Binding
 * union runs text, data, json, wasmModule, cryptoKey, service, durableObjectClass,
 * durableObjectNamespace, kvNamespace, r2Bucket, wrapped, queue, fromEnvironment, analyticsEngine,
 * hyperdrive, unsafeEval, memoryCache, workerLoader and workerdDebugPort. `wrapped` takes an
 * internal module and a set of inner bindings and makes the module's return value the binding, so
 * an api with no field is expressible after all. Declaring either unsupported would have closed
 * the objective on the strength of one mechanism.
 */
const base: PlanInput = {
	tenant: { name: 'acme', sites: [] },
	site: { host: 'api.example.edu', bundle: 'w.tar.gz' },
	paths: {
		bundle: '/b',
		storage: '/s',
		assets: '/a',
		adapterSocket: '/run/acme.sock',
		listenSocket: '/run/acme-http.sock'
	},
	modules: [{ name: 'index.js', kind: 'esModule', embed: 'index.js' }],
	compatibilityDate: '2026-08-01',
	compatibilityFlags: ['nodejs_compat'],
	uniqueKey: 'acme:api.example.edu',
	residency: 'evict',
	bindings: {},
	vars: {}
};

const render = (bindings: PlanInput['bindings']) => renderConfig(planSite({ ...base, bindings }));

describe('a D1 binding', () => {
	const config = render({ d1: ['DB'] });

	it('is a wrapped binding, since workerd has no d1Database field', () => {
		expect(config).toContain('(name = "DB", wrapped = (moduleName = "bastion:d1"');
	});

	it('names default as the entrypoint, which is what workerd calls', () => {
		expect(config).toContain('entrypoint = "default"');
	});

	it('hands the shim a fetcher for the sql adapter and nothing else', () => {
		expect(config).toContain(
			`innerBindings = [(name = "fetcher", service = "${ADAPTER_SERVICES.sql}")]`
		);
	});

	it('declares the module as an extension, because workerd loads no other kind', () => {
		expect(config).toContain('extensions = [');
		expect(config).toContain(`(name = "${SHIM_MODULES.d1}", internal = true`);
	});

	it('marks it internal, so user code cannot import the shim directly', () => {
		expect(config).toContain('internal = true');
	});

	it('attaches the sql service the shim dials', () => {
		expect(config).toContain(`(name = "${ADAPTER_SERVICES.sql}", external =`);
	});

	it('carries several databases as several bindings over one service', () => {
		const many = render({ d1: ['DB', 'DB_SECONDARY'] });
		expect(many).toContain('(name = "DB", wrapped =');
		expect(many).toContain('(name = "DB_SECONDARY", wrapped =');
		expect(many.match(/bastion_sql", external/g)).toHaveLength(1);
	});
});

describe('an AI binding', () => {
	const config = render({ ai: ['AI'] });

	it('is a wrapped binding over the ai adapter', () => {
		expect(config).toContain('(name = "AI", wrapped = (moduleName = "bastion:ai"');
		expect(config).toContain(
			`innerBindings = [(name = "fetcher", service = "${ADAPTER_SERVICES.ai}")]`
		);
	});

	it('declares its own module', () => {
		expect(config).toContain(`(name = "${SHIM_MODULES.ai}", internal = true`);
	});

	it('attaches the ai service', () => {
		expect(config).toContain(`(name = "${ADAPTER_SERVICES.ai}", external =`);
	});
});

describe('a site that binds neither', () => {
	const config = render({ kv: ['SESSIONS'] });

	it('declares no extensions at all', () => {
		expect(config).not.toContain('extensions = [');
	});

	it('ships no shim javascript into the tenant', () => {
		expect(config).not.toContain('bastion:d1');
		expect(config).not.toContain('bastion:ai');
	});

	it('attaches neither service', () => {
		expect(config).not.toContain(ADAPTER_SERVICES.sql);
		expect(config).not.toContain(ADAPTER_SERVICES.ai);
	});
});

describe('both at once', () => {
	const config = render({ d1: ['DB'], ai: ['AI'] });

	it('declares both modules under one extensions block', () => {
		expect(config.match(/extensions = \[/g)).toHaveLength(1);
		expect(config).toContain('bastion:d1');
		expect(config).toContain('bastion:ai');
	});

	it('still renders a parseable-looking config with sockets last in the struct', () => {
		expect(config).toContain('sockets = [');
		expect(config.indexOf('sockets = [')).toBeLessThan(config.indexOf('extensions = ['));
	});
});

describe('the shim sources themselves', () => {
	it('the D1 shim default-exports a function, which is what the entrypoint names', () => {
		expect(D1_SHIM).toContain('export default function (env)');
	});

	it('the AI shim does too', () => {
		expect(AI_SHIM).toContain('export default function (env)');
	});

	it('each reads only the fetcher it was given', () => {
		expect(D1_SHIM).toContain('env.fetcher');
		expect(AI_SHIM).toContain('env.fetcher');
	});

	it('the D1 shim covers the statement surface a worker actually calls', () => {
		for (const method of ['prepare', 'bind', 'first', 'all', 'run', 'raw', 'batch', 'exec']) {
			expect(D1_SHIM).toContain(method);
		}
	});

	it('the D1 shim refuses dump rather than answering with something restorable-looking', () => {
		expect(D1_SHIM).toMatch(/dump[\s\S]*cannot dump a file/);
	});

	it('the AI shim posts to the run route the adapter serves', () => {
		expect(AI_SHIM).toContain("'http://bastion/ai/run'");
	});

	it('the D1 shim posts to the sql route the adapter serves', () => {
		expect(D1_SHIM).toContain("'http://bastion/sql'");
	});

	it('neither shim holds a credential or any state between calls', () => {
		for (const shim of [D1_SHIM, AI_SHIM]) {
			expect(shim).not.toMatch(/password|secret|token|apiKey/i);
		}
	});

	it('escapes into the capnp text literal rather than breaking out of it', () => {
		const config = render({ d1: ['DB'] });
		// the shim carries quotes and newlines; an unescaped one would end the literal early
		expect(config).not.toMatch(/esModule = "[^"]*\n/);
	});
});
