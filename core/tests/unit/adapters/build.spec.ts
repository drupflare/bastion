import { describe, expect, it } from 'vitest';
import { buildAdapters, memoryAdapters } from '../../../src/adapters/build';
import { objectKv } from '../../../src/adapters/objects';
import { defaultConfig } from '../../../src/config/defaults';
import type { BastionConfig, TenantConfig } from '../../../src/config/types';
import { defaultContext } from '../../../src/context';
import { fsObjectStore } from '../../../src/drivers/fs-object';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import { DataPointWindow } from '../../../src/observe/analytics';

function ctx() {
	return { ...defaultContext(), files: memoryFiles(), io: memoryIo(), env: {}, now: () => 0 };
}

/** the shipped defaults with the two drivers that would open a real file swapped for memory */
function config(over: Partial<BastionConfig> = {}): BastionConfig {
	const base = defaultConfig();
	return {
		...base,
		drivers: {
			...base.drivers,
			cache: { driver: 'memory' },
			kv: { driver: 'memory' },
			queues: { driver: 'memory' },
			r2: { driver: 'fs', root: '/srv/objects' },
			d1: { driver: 'sqlite', path: ':memory:' }
		},
		...over
	};
}

const acme: TenantConfig = { name: 'acme', sites: [] };
const TENANT = '/srv/tenants/acme';

describe('the slots every tenant gets', () => {
	it('builds the four a config always carries a driver for', () => {
		const set = buildAdapters(ctx(), { config: config(), tenant: acme, state: TENANT });
		expect(set.cache.id()).toBe('memory');
		expect(set.kv.id()).toBe('memory');
		expect(set.queues.id()).toBe('memory');
		expect(set.r2.id()).toBe('fs');
	});

	it('labels every analytics write with the tenant it came from', () => {
		const set = buildAdapters(ctx(), { config: config(), tenant: acme, state: TENANT });
		expect(set.tenant).toBe('acme');
	});

	it('serves sql, which has no capnp binding and reaches the bundle through a shim', () => {
		const set = buildAdapters(ctx(), { config: config(), tenant: acme, state: TENANT });
		expect(set.sql).toBeDefined();
	});

	/** two tenants over one `files` seam, which is what a box actually is */
	function twoTenants(over: Partial<BastionConfig> = {}) {
		const files = memoryFiles();
		const local = { ...ctx(), files };
		const shared = config({
			drivers: { ...config().drivers, r2: { driver: 'fs' } },
			...over
		});
		return {
			files,
			acme: buildAdapters(local, { config: shared, tenant: acme, state: TENANT }),
			other: buildAdapters(local, {
				config: shared,
				tenant: { name: 'other', sites: [] },
				state: '/srv/tenants/other'
			})
		};
	}

	/**
	 * A local driver's data goes under the TENANT, never under a path shared by the box.
	 *
	 * The registry's own fallbacks were absolute `/var/lib/bastion` paths, so moving `state:` left
	 * the stores behind in a directory the operator had not configured. Worse, one path for every
	 * tenant is one keyspace for every tenant: a flat `GET foo` from one reads another's value, and
	 * the tenant boundary stops being a boundary.
	 */
	it('keeps one tenant out of the objects another tenant wrote', async () => {
		const box = twoTenants();
		await box.acme.r2.put('secret', new TextEncoder().encode('acme only'));
		expect(await box.other.r2.get('secret')).toBeNull();
		expect(box.files.exists('/var/lib/bastion/objects/secret')).toBe(false);
	});

	it('shares one store when the operator names the same root deliberately', async () => {
		const box = twoTenants({
			drivers: { ...config().drivers, r2: { driver: 'fs', root: '/srv/shared' } }
		});
		await box.acme.r2.put('notice', new TextEncoder().encode('read me'));
		expect(new TextDecoder().decode((await box.other.r2.get('notice'))?.bytes)).toBe('read me');
	});
});

/**
 * Two gates, and conflating them is how an operator debugs the wrong one.
 *
 * A slot with no driver configured does not exist at all, which is the hard no: nothing is
 * installed, so no setting turns it on. A capability withdrawn is the policy no: the box could
 * serve it and this tenant may not. Both leave the slot out rather than binding a socket whose
 * handler refuses, so the generated config and the sockets bastion serves stay the same set.
 */
describe('which optional slots are built', () => {
	const withAi = config({
		drivers: { ...config().drivers, ai: { driver: 'ollama', endpoint: 'http://127.0.0.1' } }
	});

	it('leaves ai out while no driver names an endpoint, which is the shipped default', () => {
		const set = buildAdapters(ctx(), { config: config(), tenant: acme, state: TENANT });
		expect(set.ai).toBeUndefined();
	});

	it('builds it once the operator configures one', () => {
		const set = buildAdapters(ctx(), { config: withAi, tenant: acme, state: TENANT });
		expect(set.ai).toBeDefined();
	});

	it('withdraws it for a tenant that declines the capability', () => {
		const tenant: TenantConfig = { name: 'acme', sites: [], capabilities: { ai: false } };
		const set = buildAdapters(ctx(), { config: withAi, tenant, state: TENANT });
		expect(set.ai).toBeUndefined();
	});

	it('withdraws it for one site inside a tenant that keeps it', () => {
		const site = { host: 'a.example.edu', bundle: '/b', capabilities: { ai: false } };
		const tenant: TenantConfig = { name: 'acme', sites: [site] };
		expect(buildAdapters(ctx(), { config: withAi, tenant, state: TENANT }).ai).toBeDefined();
		expect(
			buildAdapters(ctx(), { config: withAi, tenant, site, state: TENANT }).ai
		).toBeUndefined();
	});

	it('leaves browser out until a driver names one, rather than assuming chromium', () => {
		const set = buildAdapters(ctx(), { config: config(), tenant: acme, state: TENANT });
		expect(set.browser).toBeUndefined();
	});

	it('leaves images out until a driver names one, because magick ships with nothing', () => {
		const set = buildAdapters(ctx(), { config: config(), tenant: acme, state: TENANT });
		expect(set.images).toBeUndefined();
	});

	it('leaves analytics out with no window to write into', () => {
		const set = buildAdapters(ctx(), { config: config(), tenant: acme, state: TENANT });
		expect(set.analytics).toBeUndefined();
	});

	it('takes the window the runtime owns when there is one', () => {
		const set = buildAdapters(ctx(), {
			config: config(),
			tenant: acme,
			state: TENANT,
			analytics: new DataPointWindow()
		});
		expect(set.analytics).toBeDefined();
	});
});

describe('refusals', () => {
	const broken = (slot: string, driver: string) =>
		buildAdapters(ctx(), {
			config: config({ drivers: { ...config().drivers, [slot]: { driver } } }),
			tenant: acme,
			state: TENANT
		});

	it('names the slot rather than starting against a driver it does not have', () => {
		expect(() => broken('vectorize', 'pinecone')).toThrow(/not a vectorize driver/);
	});

	it('refuses an ai driver it has no client shape for', () => {
		expect(() => broken('ai', 'bedrock')).toThrow(/not a ai driver/);
	});

	it('refuses an images driver it has no command for', () => {
		expect(() => broken('images', 'sharp')).toThrow(/not a images driver/);
	});

	it('refuses a browser driver it has no command for', () => {
		expect(() => broken('browser', 'firefox')).toThrow(/not a browser driver/);
	});

	it('refuses smtp with no transport rather than picking a mail library', () => {
		const mail = config({
			drivers: { ...config().drivers, email: { driver: 'smtp', host: 'smtp.example.edu' } }
		});
		expect(() => buildAdapters(ctx(), { config: mail, tenant: acme, state: TENANT })).toThrow(
			/needs a transport/
		);
	});
});

/**
 * The R2 slot is served over the key/value wire shape, so the object store is narrowed to it.
 *
 * What the narrowing loses is refused rather than dropped: an expiry has nowhere to live on an
 * object, and a driver that silently discarded it would store something its reader cannot tell
 * from a value that simply has not expired yet.
 */
describe('objectKv', () => {
	const store = () => objectKv(fsObjectStore(ctx(), '/srv/objects'));

	it('round trips bytes', async () => {
		const kv = store();
		await kv.put('a', new TextEncoder().encode('hello'));
		expect(new TextDecoder().decode((await kv.get('a'))?.bytes)).toBe('hello');
	});

	it('answers null for a key that is not there', async () => {
		expect(await store().get('missing')).toBeNull();
	});

	it('carries the metadata through rather than dropping it', async () => {
		const kv = store();
		await kv.put('a', new Uint8Array([1]), { metadata: { owner: 'acme' } });
		expect((await kv.get('a'))?.metadata).toMatchObject({ owner: 'acme' });
	});

	it('lists what it holds', async () => {
		const kv = store();
		await kv.put('one', new Uint8Array([1]));
		await kv.put('two', new Uint8Array([2]));
		expect((await kv.list()).keys.map((key) => key.name).sort()).toEqual(['one', 'two']);
	});

	it('deletes', async () => {
		const kv = store();
		await kv.put('a', new Uint8Array([1]));
		expect(await kv.delete(['a'])).toBe(1);
		expect(await kv.get('a')).toBeNull();
	});

	it('refuses a per-key expiry rather than storing a value that never expires', async () => {
		await expect(store().put('a', new Uint8Array([1]), { expiresAt: 1 })).rejects.toThrow(
			/per-key expiry/
		);
	});

	it('declines ttl in its capabilities, so a caller never asks in the first place', () => {
		expect(store().capabilities().ttl).toBe(false);
	});
});

describe('memoryAdapters', () => {
	it('holds everything in the process, so the gate lane opens no file', () => {
		const set = memoryAdapters(ctx(), { config: config(), tenant: acme, state: TENANT });
		expect(set.cache.id()).toBe('memory');
		expect(set.kv.id()).toBe('memory');
		expect(set.sql).toBeUndefined();
	});
});
