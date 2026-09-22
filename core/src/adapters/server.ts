import type { DataPoint, DataPointWindow } from '../observe/analytics';
import { parseAiRequest, type AiStore } from './ai';
import type { BrowserStore, RenderRequest } from './browser';
import type { CacheStore } from './cache';
import type { EmailStore } from './email';
import type { ImagePipeline, ImageStore } from './images';
import { CACHE_STATUS, keyFromPath, STORE_STATUS } from './protocol';
import { parseSqlRequest, type SqlStore } from './sql';
import type { KeyValueStore } from './store';
import {
	parseVectorRequest,
	type VectorQuery,
	type VectorRecord,
	type VectorStore
} from './vectors';

export interface AdapterSet {
	cache: CacheStore;
	kv: KeyValueStore;
	r2: KeyValueStore;
	queues: KeyValueStore;
	/** resolves an asset path to its bytes and content type, or null when it is not servable */
	assets(path: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
	/** D1 has no capnp binding, so a bundle reaches sql through the wrapped shim */
	sql?: SqlStore;
	/** Workers AI has no capnp binding either; same mechanism, different endpoint */
	ai?: AiStore;
	/** Vectorize, same mechanism again over whatever index the operator runs */
	vectorize?: VectorStore;
	/** outbound mail over the operator's own smtp server; a worker cannot open port 25, bastion can */
	email?: EmailStore;
	/** native image transformation, which is not bounded by what fits in an isolate */
	images?: ImageStore;
	/** a headless browser on the host, which a Worker cannot fork and bastion can */
	browser?: BrowserStore;
	/** analytics engine without the --experimental flag its native binding is gated behind */
	analytics?: DataPointWindow;
	/** the tenant every analytics write is labelled with */
	tenant?: string;
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
		case 'sql':
			return handleSql(adapters.sql, request);
		case 'ai':
			return handleAi(adapters.ai, request, path);
		case 'vectorize':
			return handleVectors(adapters.vectorize, request, path);
		case 'email':
			return handleEmail(adapters.email, request);
		case 'images':
			return handleImages(adapters.images, request, path);
		case 'browser':
			return handleBrowser(adapters.browser, request, path);
		case 'analytics':
			return handleAnalytics(adapters.analytics, request, adapters.tenant ?? 'unknown');
		default:
			return Promise.resolve(new Response('no such adapter', { status: 404 }));
	}
}

/**
 * The SQL slot, which the driver has always had and nothing served.
 *
 * A batch is applied in order and answers one result per statement, so a caller cannot tell a
 * partial application from a whole one by the shape of the reply. A driver that is not configured
 * answers 501 rather than 404, because the path exists and the backing does not.
 */
async function handleSql(store: SqlStore | undefined, request: Request): Promise<Response> {
	if (store === undefined) {
		return new Response('no sql driver is configured', { status: 501 });
	}
	if (request.method !== 'POST') {
		return new Response('the sql adapter takes POST', { status: 405 });
	}
	let parsed;
	try {
		parsed = parseSqlRequest(await request.json());
	} catch (error) {
		return new Response(error instanceof Error ? error.message : 'bad request', {
			status: 400
		});
	}
	const results =
		parsed.batch === undefined
			? [await store.query(parsed.sql, parsed.params)]
			: await store.batch(parsed.batch);
	return Response.json({ results });
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

/**
 * The AI slot, which forwards to whatever inference endpoint the operator configured.
 *
 * A refusal from the driver is passed through with its message rather than flattened to a 500: the
 * common case is a model the endpoint does not serve, and the caller can only fix that if it is
 * told which one was asked for.
 */
async function handleAi(
	store: AiStore | undefined,
	request: Request,
	path: string
): Promise<Response> {
	if (store === undefined) {
		return new Response('no ai driver is configured', { status: 501 });
	}
	if (path.startsWith('/models')) {
		return Response.json({ models: await store.models() });
	}
	if (path !== '/run') return new Response('no such ai route', { status: 404 });
	if (request.method !== 'POST')
		return new Response('the ai adapter takes POST', { status: 405 });

	let parsed;
	try {
		parsed = parseAiRequest(await request.json());
	} catch (error) {
		return new Response(error instanceof Error ? error.message : 'bad request', {
			status: 400
		});
	}
	try {
		const answer = await store.run(parsed);
		if ('stream' in answer) {
			return new Response(answer.stream, {
				headers: { 'content-type': 'text/event-stream' }
			});
		}
		return Response.json({ result: answer.result });
	} catch (error) {
		return new Response(error instanceof Error ? error.message : 'inference failed', {
			status: 502
		});
	}
}

/**
 * The Vectorize slot.
 *
 * Six routes, each one a method on the store. `insert` and `upsert` are separate because the
 * difference is observable: insert leaves an existing id alone and upsert replaces it, and a
 * caller that wanted one and got the other loses data with no error.
 */
async function handleVectors(
	store: VectorStore | undefined,
	request: Request,
	path: string
): Promise<Response> {
	if (store === undefined) {
		return new Response('no vectorize driver is configured', { status: 501 });
	}
	if (path === '/describe') return Response.json(await store.describe());
	if (request.method !== 'POST') {
		return new Response('the vectorize adapter takes POST', { status: 405 });
	}

	let body: Record<string, unknown>;
	try {
		body = parseVectorRequest(await request.json());
	} catch (error) {
		return new Response(error instanceof Error ? error.message : 'bad request', {
			status: 400
		});
	}
	try {
		const records = (body.records ?? []) as VectorRecord[];
		const ids = (body.ids ?? []) as string[];
		switch (path) {
			case '/insert':
				return Response.json(await store.insert(records));
			case '/upsert':
				return Response.json(await store.upsert(records));
			case '/query':
				return Response.json(await store.query(body as unknown as VectorQuery));
			case '/get':
				return Response.json({ records: await store.getByIds(ids) });
			case '/delete':
				return Response.json(await store.deleteByIds(ids));
			default:
				return new Response('no such vectorize route', { status: 404 });
		}
	} catch (error) {
		return new Response(error instanceof Error ? error.message : 'the index refused', {
			status: 400
		});
	}
}

/** the email slot; the message is passed through so a DKIM signature still verifies */
async function handleEmail(store: EmailStore | undefined, request: Request): Promise<Response> {
	if (store === undefined) return new Response('no email driver is configured', { status: 501 });
	if (request.method !== 'POST') {
		return new Response('the email adapter takes POST', { status: 405 });
	}
	const from = request.headers.get('x-bastion-from');
	const to = request.headers.get('x-bastion-to');
	if (from === null || to === null) {
		return new Response('a message needs from and to', { status: 400 });
	}
	try {
		await store.send({ from, to, raw: await request.text() });
		return new Response(null, { status: 202 });
	} catch (error) {
		return new Response(error instanceof Error ? error.message : 'the mail server refused', {
			status: 502
		});
	}
}

/** the images slot; the pipeline rides in a header so the body stays the raw source bytes */
async function handleImages(
	store: ImageStore | undefined,
	request: Request,
	path: string
): Promise<Response> {
	if (store === undefined) return new Response('no images driver is configured', { status: 501 });
	if (request.method !== 'POST') {
		return new Response('the images adapter takes POST', { status: 405 });
	}
	const bytes = new Uint8Array(await request.arrayBuffer());
	try {
		if (path === '/info') return Response.json(await store.info(bytes));
		if (path !== '/transform') return new Response('no such images route', { status: 404 });

		let pipeline: ImagePipeline;
		try {
			pipeline = JSON.parse(request.headers.get('x-bastion-ops') ?? '{}') as ImagePipeline;
		} catch {
			return new Response('the pipeline header is not json', { status: 400 });
		}
		const done = await store.transform(bytes, {
			ops: pipeline.ops ?? [],
			output: pipeline.output ?? {}
		});
		return new Response(done.bytes, { headers: { 'content-type': done.contentType } });
	} catch (error) {
		return new Response(error instanceof Error ? error.message : 'the transform failed', {
			status: 400
		});
	}
}

/** the analytics slot; a write answers 204 and never reports a reason, as the binding does not */
async function handleAnalytics(
	window: DataPointWindow | undefined,
	request: Request,
	tenant: string
): Promise<Response> {
	if (window === undefined) return new Response(null, { status: 501 });
	if (request.method !== 'POST') return new Response(null, { status: 405 });
	try {
		const body = (await request.json()) as Partial<DataPoint>;
		window.write({
			indexes: Array.isArray(body.indexes) ? body.indexes.map(String) : [],
			doubles: Array.isArray(body.doubles) ? body.doubles.map(Number) : [],
			blobs: Array.isArray(body.blobs) ? body.blobs.map(String) : [],
			at: Date.now(),
			tenant,
			site: null
		});
	} catch {
		return new Response(null, { status: 400 });
	}
	return new Response(null, { status: 204 });
}

/** the browser slot; a render is the one call here that fetches a url of the worker's choosing */
async function handleBrowser(
	store: BrowserStore | undefined,
	request: Request,
	path: string
): Promise<Response> {
	if (store === undefined)
		return new Response('no browser driver is configured', { status: 501 });
	// the devtools upgrade is puppeteer's transport and is proxied rather than interpreted
	if (path === '/devtools') {
		const url = await store.devtools();
		return url === null
			? new Response('this node exposes no devtools endpoint', { status: 501 })
			: Response.json({ webSocketDebuggerUrl: url });
	}
	if (request.method !== 'POST') {
		return new Response('the browser adapter takes POST', { status: 405 });
	}
	let body: RenderRequest;
	try {
		body = (await request.json()) as RenderRequest;
	} catch {
		return new Response('the render request is not json', { status: 400 });
	}
	try {
		if (path === '/screenshot' || path === '/pdf') {
			const done = path === '/pdf' ? await store.pdf(body) : await store.screenshot(body);
			return new Response(done.bytes, { headers: { 'content-type': done.contentType } });
		}
		if (path === '/content') {
			return new Response(await store.content(body), {
				headers: { 'content-type': 'text/html' }
			});
		}
		return new Response('no such browser route', { status: 404 });
	} catch (error) {
		return new Response(error instanceof Error ? error.message : 'the render failed', {
			status: 400
		});
	}
}
