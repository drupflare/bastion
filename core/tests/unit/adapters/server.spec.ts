import { describe, expect, it } from 'vitest';
import { ASSET_PROFILES, assetResolver } from '../../../src/adapters/assets';
import { memoryCacheStore } from '../../../src/adapters/cache';
import {
	CACHE_STATUS,
	keyFromPath,
	pathFromKey,
	STORE_STATUS
} from '../../../src/adapters/protocol';
import { handleAdapterRequest, type AdapterSet } from '../../../src/adapters/server';
import { memoryKv } from '../../../src/drivers/memory-kv';
import { memoryFiles } from '../../../src/host/files';

const ROOT = '/srv/assets';

function adapters(): AdapterSet {
	const files = memoryFiles({
		[`${ROOT}/style.css`]: 'body{}',
		[`${ROOT}/drupal/site.sqlite`]: new Uint8Array([1, 2, 3])
	});
	return {
		cache: memoryCacheStore(),
		kv: memoryKv(),
		r2: memoryKv(),
		queues: memoryKv(),
		assets: assetResolver(files, ROOT, ASSET_PROFILES.drupflare)
	};
}

const call = (
	set: AdapterSet,
	method: string,
	path: string,
	body?: string,
	headers?: Record<string, string>
) =>
	handleAdapterRequest(
		set,
		new Request(`http://unix${path}`, {
			method,
			...(body === undefined ? {} : { body }),
			headers
		})
	);

describe('routing', () => {
	it('answers 404 for an unknown adapter', async () => {
		expect((await call(adapters(), 'GET', '/nope/x')).status).toBe(404);
	});
});

describe('the cache protocol, as workerd expects it', () => {
	// measured from the stub workerd accepted; a wrong miss status never caches, silently
	it('answers 504 on a miss', async () => {
		expect((await call(adapters(), 'GET', '/cache/a')).status).toBe(CACHE_STATUS.miss);
	});

	it('answers 204 on a store, then 200 with the bytes', async () => {
		const set = adapters();
		expect((await call(set, 'PUT', '/cache/a', 'stored')).status).toBe(CACHE_STATUS.stored);
		const hit = await call(set, 'GET', '/cache/a');
		expect(hit.status).toBe(200);
		expect(await hit.text()).toBe('stored');
	});

	it('answers 404 when purging a key it does not hold', async () => {
		expect((await call(adapters(), 'PURGE', '/cache/a')).status).toBe(
			CACHE_STATUS.purgedAbsent
		);
	});

	it('answers 200 when purging one it does', async () => {
		const set = adapters();
		await call(set, 'PUT', '/cache/a', 'x');
		expect((await call(set, 'PURGE', '/cache/a')).status).toBe(200);
	});

	it('refuses any other method', async () => {
		expect((await call(adapters(), 'POST', '/cache/a')).status).toBe(
			CACHE_STATUS.methodNotAllowed
		);
	});
});

describe('the kv protocol', () => {
	it('answers 404 for an absent key', async () => {
		expect((await call(adapters(), 'GET', '/kv/missing')).status).toBe(STORE_STATUS.absent);
	});

	it('round-trips a value', async () => {
		const set = adapters();
		expect((await call(set, 'PUT', '/kv/a', 'one')).status).toBe(STORE_STATUS.written);
		expect(await (await call(set, 'GET', '/kv/a')).text()).toBe('one');
	});

	it('deletes', async () => {
		const set = adapters();
		await call(set, 'PUT', '/kv/a', 'one');
		expect((await call(set, 'DELETE', '/kv/a')).status).toBe(STORE_STATUS.deleted);
		expect((await call(set, 'GET', '/kv/a')).status).toBe(STORE_STATUS.absent);
	});

	it('keeps r2 and queues in their own keyspaces', async () => {
		const set = adapters();
		await call(set, 'PUT', '/kv/same', 'kv');
		await call(set, 'PUT', '/r2/same', 'r2');
		expect(await (await call(set, 'GET', '/kv/same')).text()).toBe('kv');
		expect(await (await call(set, 'GET', '/r2/same')).text()).toBe('r2');
		expect((await call(set, 'GET', '/queues/same')).status).toBe(STORE_STATUS.absent);
	});

	it('decodes a key that needed escaping in the path', async () => {
		const set = adapters();
		const key = 'a/b c';
		await call(set, 'PUT', `/kv${pathFromKey(key)}`, 'x');
		expect(await (await call(set, 'GET', `/kv${pathFromKey(key)}`)).text()).toBe('x');
		expect(keyFromPath(pathFromKey(key))).toBe(key);
	});
});

describe('assets', () => {
	it('serves a stylesheet with a real content type and nosniff', async () => {
		const res = await call(adapters(), 'GET', '/assets/style.css');
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});

	// the leak the smoke lane shipped, closed at the only layer the site cannot reach around
	it('answers 404 for the site database', async () => {
		expect((await call(adapters(), 'GET', '/assets/drupal/site.sqlite')).status).toBe(404);
	});

	it('answers a HEAD with headers and no body', async () => {
		const res = await call(adapters(), 'HEAD', '/assets/style.css');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('');
	});

	it('refuses a write', async () => {
		expect((await call(adapters(), 'PUT', '/assets/style.css', 'x')).status).toBe(405);
	});
});
