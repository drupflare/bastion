import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderConfig } from '../../../src/capnp/generate';
import { ADAPTER_SERVICES, planSite, type PlanInput } from '../../../src/capnp/plan';

/**
 * The 2026-09-21 smoke lane is the only configuration anyone has booted the real bundle under.
 * These assertions read the recovered fixture rather than restating it, so a generator change that
 * drifts from the measured shape fails here instead of producing a config nobody has run.
 */
const fixture = readFileSync(
	new URL('../../fixtures/smoke/config2.capnp', import.meta.url),
	'utf8'
);

const input: PlanInput = {
	tenant: { name: 'acme', sites: [] },
	site: { host: 'www.example.edu', bundle: 'payload.tar.gz', probe: 'drupflare' },
	paths: {
		bundle: '/var/lib/bastion/t/acme/bundle',
		storage: '/var/lib/bastion/t/acme/storage',
		assets: '/var/lib/bastion/t/acme/assets',
		adapterSocket: '/run/bastion/acme.sock',
		listenSocket: '/run/bastion/acme-http.sock'
	},
	modules: [
		{ name: 'site.js', kind: 'esModule', embed: 'site.js' },
		{ name: 'php8.5.tuned.wasm', kind: 'wasm', embed: 'php8.5.tuned.wasm' }
	],
	compatibilityDate: '2026-08-01',
	compatibilityFlags: ['nodejs_compat'],
	uniqueKey: 'acme-www-example-edu',
	durableObjectClass: 'SitePhpDurableObject',
	residency: 'evict',
	bindings: {
		durableObject: 'SITE',
		assets: 'ASSETS',
		kv: ['CONFIG_KV', 'PAGE_KV'],
		r2: [],
		queues: []
	},
	vars: { PLAN: 'free', LAZY_MOUNT: '1' }
};

const generated = renderConfig(planSite(input));

describe('the measured configuration, read out of the fixture', () => {
	it('the fixture pins cacheApiOutbound, and so does the generator', () => {
		expect(fixture).toMatch(/cacheApiOutbound = "/);
		expect(generated).toContain(`cacheApiOutbound = "${ADAPTER_SERVICES.cache}"`);
	});

	it('the fixture enables sql on the namespace, and so does the generator', () => {
		expect(fixture).toContain('enableSql = true');
		expect(generated).toContain('enableSql = true');
	});

	it('the fixture stores durable objects on local disk, and so does the generator', () => {
		expect(fixture).toMatch(/durableObjectStorage = \(localDisk = "/);
		expect(generated).toContain(
			`durableObjectStorage = (localDisk = "${ADAPTER_SERVICES.storage}")`
		);
	});

	it('the fixture binds KV through a ServiceDesignator, and so does the generator', () => {
		expect(fixture).toMatch(/kvNamespace = "/);
		for (const name of input.bindings.kv) {
			expect(generated).toContain(
				`(name = "${name}", kvNamespace = "${ADAPTER_SERVICES.kv}")`
			);
		}
	});

	it('carries every compatibility flag the fixture used', () => {
		expect(fixture).toContain('"nodejs_compat"');
		expect(generated).toContain('compatibilityFlags = ["nodejs_compat"]');
	});

	it('names the same durable object class the fixture booted', () => {
		expect(fixture).toContain('SitePhpDurableObject');
		expect(generated).toContain('className = "SitePhpDurableObject"');
	});
});

describe('where the generator deliberately differs from the rig', () => {
	// the rig exposed the raw disk on its own socket and it served the whole site database
	// publicly; bastion puts a worker in front and never gives the disk a socket
	it('never puts the assets disk on a socket', () => {
		expect(fixture).toContain('service = "assetdir"');
		expect(generated).not.toContain(`service = "${ADAPTER_SERVICES.assetsDisk}"`);
		const sockets = generated.slice(generated.indexOf('sockets = ['));
		expect(sockets).not.toMatch(/disk/);
	});

	it('routes assets through a worker service instead', () => {
		expect(generated).toContain(`(name = "ASSETS", service = "${ADAPTER_SERVICES.assets}")`);
	});

	// the rig used an always-miss stub, which puts 100% of traffic on the object
	it('points the cache at a real bastion service rather than a null stub', () => {
		expect(generated).toContain(`(name = "${ADAPTER_SERVICES.cache}", external =`);
	});

	it('pins egress to a deny-by-default network service', () => {
		expect(generated).toContain(`globalOutbound = "${ADAPTER_SERVICES.outbound}"`);
		expect(generated).toContain(
			`(name = "${ADAPTER_SERVICES.outbound}", network = (allow = [], deny = ["public"]))`
		);
	});
});

describe('capabilities are enforced by absence', () => {
	it('emits no unsafeEval binding by default', () => {
		expect(generated).not.toContain('unsafeEval');
	});

	it('emits one only when the tenant turns codegen on', () => {
		const on = renderConfig(
			planSite({ ...input, tenant: { ...input.tenant, capabilities: { codegen: true } } })
		);
		expect(on).toContain('unsafeEval = void');
	});

	it('pins the object in memory only under residency pin', () => {
		expect(generated).not.toContain('preventEviction');
		const pinned = renderConfig(planSite({ ...input, residency: 'pin' }));
		expect(pinned).toContain('preventEviction = true');
	});
});
