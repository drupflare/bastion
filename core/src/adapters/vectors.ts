/**
 * Vectorize, over whatever index the operator runs.
 *
 * The third binding built on the wrapped-module mechanism, and it exists to show the mechanism
 * generalises: workerd has no `vectorize` field either, and the shape in front of it is the only
 * part Cloudflare owns. Everything under it is an index, and an index is something a box can run.
 *
 * Two drivers, and the split is the same one the AI adapter makes. `memoryVectors` is exact and
 * self-contained; a remote driver speaks to a real vector database for the case where the index
 * outgrows a process.
 */

import type { Context } from '../context';
import { BastionError } from '../errors';

export interface VectorRecord {
	id: string;
	values: number[];
	namespace?: string;
	metadata?: Record<string, unknown>;
}

export interface VectorMatch {
	id: string;
	score: number;
	values?: number[];
	namespace?: string;
	metadata?: Record<string, unknown>;
}

export interface VectorQuery {
	values: number[];
	topK?: number;
	namespace?: string;
	returnValues?: boolean;
	returnMetadata?: boolean | 'none' | 'indexed' | 'all';
	filter?: Record<string, unknown>;
}

export interface VectorStore {
	id(): string;
	describe(): Promise<{ dimensions: number; count: number; metric: VectorMetric }>;
	insert(records: VectorRecord[]): Promise<{ mutationId: string; count: number }>;
	upsert(records: VectorRecord[]): Promise<{ mutationId: string; count: number }>;
	query(query: VectorQuery): Promise<{ matches: VectorMatch[]; count: number }>;
	getByIds(ids: string[]): Promise<VectorRecord[]>;
	deleteByIds(ids: string[]): Promise<{ mutationId: string; count: number }>;
	isReachable(): Promise<boolean>;
}

export type VectorMetric = 'cosine' | 'euclidean' | 'dot-product';

export function score(a: number[], b: number[], metric: VectorMetric): number {
	let dot = 0;
	let aa = 0;
	let bb = 0;
	let sq = 0;
	for (let i = 0; i < a.length; i += 1) {
		const x = a[i] as number;
		const y = b[i] as number;
		dot += x * y;
		aa += x * x;
		bb += y * y;
		sq += (x - y) * (x - y);
	}
	if (metric === 'dot-product') return dot;
	if (metric === 'euclidean') return Math.sqrt(sq);
	const norm = Math.sqrt(aa) * Math.sqrt(bb);
	// two zero vectors are not similar, they are undefined; answering 1 would rank them first
	return norm === 0 ? 0 : dot / norm;
}

/** every value in the filter must match the record's metadata, which is Vectorize's own rule */
export function matchesFilter(
	metadata: Record<string, unknown> | undefined,
	filter: Record<string, unknown> | undefined
): boolean {
	if (filter === undefined) return true;
	for (const [key, want] of Object.entries(filter)) {
		const held = metadata?.[key];
		if (want !== null && typeof want === 'object' && !Array.isArray(want)) {
			const ops = want as Record<string, unknown>;
			if ('$eq' in ops && held !== ops.$eq) return false;
			if ('$ne' in ops && held === ops.$ne) return false;
			if ('$in' in ops && (!Array.isArray(ops.$in) || !ops.$in.includes(held))) return false;
			if ('$nin' in ops && Array.isArray(ops.$nin) && ops.$nin.includes(held)) return false;
			continue;
		}
		if (held !== want) return false;
	}
	return true;
}

export interface MemoryVectorOptions {
	dimensions: number;
	metric?: VectorMetric;
	/** seeds the index, so a restart can reload what was persisted elsewhere */
	seed?: VectorRecord[];
}

/**
 * An exact index held in the process.
 *
 * ponytail: brute-force scan, O(n) per query. Exact rather than approximate, which is the right
 * trade at the scale a single institution's box actually holds; swap in the remote driver against
 * a real vector database when an index outgrows a linear scan.
 */
export function memoryVectors(options: MemoryVectorOptions): VectorStore {
	const metric = options.metric ?? 'cosine';
	const held = new Map<string, VectorRecord>();
	for (const record of options.seed ?? []) held.set(record.id, record);
	let mutation = 0;

	const write = (records: VectorRecord[], overwrite: boolean) => {
		for (const record of records) {
			if (record.values.length !== options.dimensions) {
				throw new BastionError(
					'usage',
					`this index holds ${options.dimensions} dimensions and ${record.id} carries ${record.values.length}`,
					{ next: null }
				);
			}
			if (!overwrite && held.has(record.id)) continue;
			held.set(record.id, record);
		}
		mutation += 1;
		return { mutationId: String(mutation), count: records.length };
	};

	return {
		id: () => 'memory',
		isReachable: () => Promise.resolve(true),
		describe: () =>
			Promise.resolve({ dimensions: options.dimensions, count: held.size, metric }),
		// insert leaves an existing id alone and upsert replaces it, which is the whole difference
		insert: async (records) => write(records, false),
		upsert: async (records) => write(records, true),
		getByIds: (ids) =>
			Promise.resolve(
				ids.map((id) => held.get(id)).filter((r): r is VectorRecord => r !== undefined)
			),
		deleteByIds: (ids) => {
			let removed = 0;
			for (const id of ids) if (held.delete(id)) removed += 1;
			mutation += 1;
			return Promise.resolve({ mutationId: String(mutation), count: removed });
		},
		query: async (query) => {
			if (query.values.length !== options.dimensions) {
				throw new BastionError(
					'usage',
					`this index holds ${options.dimensions} dimensions and the query carries ${query.values.length}`,
					{ next: null }
				);
			}
			const wantMetadata =
				query.returnMetadata === true ||
				query.returnMetadata === 'all' ||
				query.returnMetadata === 'indexed';
			const scored = [...held.values()]
				.filter((record) => (query.namespace ?? null) === (record.namespace ?? null))
				.filter((record) => matchesFilter(record.metadata, query.filter))
				.map((record) => ({
					id: record.id,
					score: score(query.values, record.values, metric),
					...(record.namespace === undefined ? {} : { namespace: record.namespace }),
					...(query.returnValues === true ? { values: record.values } : {}),
					...(wantMetadata && record.metadata !== undefined
						? { metadata: record.metadata }
						: {})
				}));
			// euclidean is a distance, so nearest is smallest; the other two are similarities
			scored.sort((a, b) => (metric === 'euclidean' ? a.score - b.score : b.score - a.score));
			const matches = scored.slice(0, Math.min(query.topK ?? 5, 100));
			return Promise.resolve({ matches, count: matches.length });
		}
	};
}

export interface RemoteVectorOptions {
	/** the index endpoint, e.g. a qdrant or a bastion sibling */
	endpoint: string;
	apiKey?: string;
	dimensions: number;
	metric?: VectorMetric;
}

/**
 * An index that lives somewhere else, over bastion's own wire shape.
 *
 * Deliberately not one driver per vector database. Nobody has run this against two of them yet, so
 * a second implementation would be an abstraction drawn against one, and the surviving objective
 * is recorded rather than guessed at: add the dialect only once a real endpoint has refused this.
 */
export function remoteVectors(ctx: Context, options: RemoteVectorOptions): VectorStore {
	const base = options.endpoint.replace(/\/+$/, '');
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`;

	const call = async <T>(path: string, body?: unknown): Promise<T> => {
		const response = await ctx.fetch(`${base}${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) })
		});
		if (!response.ok) {
			throw new BastionError(
				'driver-refused',
				`the vector index answered ${response.status}`,
				{ retryable: response.status >= 500 }
			);
		}
		return (await response.json()) as T;
	};

	return {
		id: () => 'remote',
		isReachable: async () => {
			try {
				return (await ctx.fetch(`${base}/describe`, { headers })).ok;
			} catch {
				return false;
			}
		},
		describe: () => call('/describe'),
		insert: (records) => call('/insert', { records }),
		upsert: (records) => call('/upsert', { records }),
		query: (query) => call('/query', query),
		getByIds: async (ids) => (await call<{ records: VectorRecord[] }>('/get', { ids })).records,
		deleteByIds: (ids) => call('/delete', { ids })
	};
}

export function parseVectorRequest(body: unknown): Record<string, unknown> {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		throw new BastionError('usage', 'the vectorize adapter expects a JSON object');
	}
	return body as Record<string, unknown>;
}
