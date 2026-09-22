import type { CacheStore } from './cache';
import { CACHE_STATUS, keyFromPath, STORE_STATUS } from './protocol';
import type { KeyValueStore } from './store';

export interface AdapterSet {
	cache: CacheStore;
	kv: KeyValueStore;
	r2: KeyValueStore;
	queues: KeyValueStore;
	/** resolves an asset path to its bytes and content type, or null when it is not servable */
	assets(path: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
}

/**
 * The request handler workerd's bound services reach over the unix socket.
 *
 * A pure function of a `Request`, so the gate lane drives every branch without binding a socket.
 * The service is selected by the first path segment, which is how one listener serves all of a
 * tenant's adapters.
 */
export function handleAdapterRequest(adapters: AdapterSet, request: Request): Promise<Response> {
	const url = new URL(request.url);
	const [, slot, ...rest] = url.pathname.split('/');
	const path = `/${rest.join('/')}`;

	switch (slot) {
		case 'cache':
			return handleCache(adapters.cache, request, path);
		case 'kv':
			return handleStore(adapters.kv, request, path);
		case 'r2':
			return handleStore(adapters.r2, request, path);
		case 'queues':
			return handleStore(adapters.queues, request, path);
		case 'assets':
			return handleAssets(adapters, request, path);
		default:
			return Promise.resolve(new Response('no such adapter', { status: 404 }));
	}
}

/**
 * The cache API over HTTP.
 *
 * The statuses are measured from the stub workerd accepted in the smoke lane, not inferred: a miss
 * is 504, a store is 204, and a purge of an absent key is 404. Answering the wrong status for a
 * miss does not fail loudly; it simply never caches.
 */
async function handleCache(store: CacheStore, request: Request, path: string): Promise<Response> {
	const key = keyFromPath(path);
	if (request.method === 'GET') {
		const entry = await store.get(key);
		if (entry === null) return new Response(null, { status: CACHE_STATUS.miss });
		return new Response(entry.bytes, { status: 200 });
	}
	if (request.method === 'PUT') {
		const bytes = new Uint8Array(await request.arrayBuffer());
		const expires = request.headers.get('x-bastion-expires');
		await store.put(key, {
			bytes,
			expiresAt: expires === null ? null : Number(expires)
		});
		return new Response(null, { status: CACHE_STATUS.stored });
	}
	if (request.method === 'PURGE') {
		const removed = await store.purge(key);
		return new Response(null, { status: removed ? 200 : CACHE_STATUS.purgedAbsent });
	}
	return new Response(null, { status: CACHE_STATUS.methodNotAllowed });
}

/** kv, r2 and queues share one shape: the key is the decoded pathname */
async function handleStore(
	store: KeyValueStore,
	request: Request,
	path: string
): Promise<Response> {
	const key = keyFromPath(path);
	if (request.method === 'GET') {
		const held = await store.get(key);
		if (held === null) return new Response('not found', { status: STORE_STATUS.absent });
		return new Response(held.bytes, { status: 200 });
	}
	if (request.method === 'PUT') {
		const bytes = new Uint8Array(await request.arrayBuffer());
		const expires = request.headers.get('x-bastion-expires');
		await store.put(key, bytes, expires === null ? undefined : { expiresAt: Number(expires) });
		return new Response(null, { status: STORE_STATUS.written });
	}
	if (request.method === 'DELETE') {
		await store.delete([key]);
		return new Response(null, { status: STORE_STATUS.deleted });
	}
	return new Response(null, { status: STORE_STATUS.methodNotAllowed });
}

/**
 * Assets, which is why a bare `disk` service is never exposed.
 *
 * A `DiskDirectory` answers everything `application/octet-stream`, ignores the ignore list, and
 * will serve a site database to anyone who names it. This applies the ignore list and a real
 * content type, and it is the only thing bound to the ASSETS designator.
 */
async function handleAssets(
	adapters: AdapterSet,
	request: Request,
	path: string
): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response(null, { status: 405 });
	}
	const found = await adapters.assets(path);
	if (found === null) return new Response('not found', { status: 404 });
	return new Response(request.method === 'HEAD' ? null : found.bytes, {
		status: 200,
		headers: { 'content-type': found.contentType, 'x-content-type-options': 'nosniff' }
	});
}
