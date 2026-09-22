import { describe, expect, it } from 'vitest';
import { memoryCacheStore } from '../../../src/adapters/cache';
import { handleAdapterRequest, type AdapterSet } from '../../../src/adapters/server';
import { matchesFilter, memoryVectors, score } from '../../../src/adapters/vectors';
import { memoryKv } from '../../../src/drivers/memory-kv';

/**
 * Vectorize over a self-hosted index.
 *
 * The third API built on the wrapped-module mechanism. What matters here is that the semantics
 * Cloudflare's own docs specify hold: insert leaves an existing id alone, upsert replaces it, a
 * namespace partitions the index, and euclidean ranks nearest-first while the other two metrics
 * rank highest-first.
 */
describe('score', () => {
	it('gives identical vectors a cosine of 1', () => {
		expect(score([1, 0], [1, 0], 'cosine')).toBeCloseTo(1);
	});

	it('gives orthogonal vectors a cosine of 0', () => {
		expect(score([1, 0], [0, 1], 'cosine')).toBeCloseTo(0);
	});

	it('gives opposite vectors a cosine of -1', () => {
		expect(score([1, 0], [-1, 0], 'cosine')).toBeCloseTo(-1);
	});

	it('answers 0 rather than 1 for a zero vector, which is undefined not identical', () => {
		expect(score([0, 0], [0, 0], 'cosine')).toBe(0);
	});

	it('measures euclidean distance', () => {
		expect(score([0, 0], [3, 4], 'euclidean')).toBeCloseTo(5);
	});

	it('measures a dot product', () => {
		expect(score([1, 2], [3, 4], 'dot-product')).toBeCloseTo(11);
	});
});

describe('matchesFilter', () => {
	it('passes everything when there is no filter', () => {
		expect(matchesFilter(undefined, undefined)).toBe(true);
	});

	it('matches a plain equality', () => {
		expect(matchesFilter({ kind: 'doc' }, { kind: 'doc' })).toBe(true);
		expect(matchesFilter({ kind: 'doc' }, { kind: 'page' })).toBe(false);
	});

	it('handles the comparison operators vectorize defines', () => {
		expect(matchesFilter({ n: 1 }, { n: { $eq: 1 } })).toBe(true);
		expect(matchesFilter({ n: 1 }, { n: { $ne: 1 } })).toBe(false);
		expect(matchesFilter({ n: 1 }, { n: { $in: [1, 2] } })).toBe(true);
		expect(matchesFilter({ n: 3 }, { n: { $in: [1, 2] } })).toBe(false);
		expect(matchesFilter({ n: 3 }, { n: { $nin: [1, 2] } })).toBe(true);
	});

	it('fails a record with no metadata against any filter', () => {
		expect(matchesFilter(undefined, { kind: 'doc' })).toBe(false);
	});
});

describe('memoryVectors', () => {
	const index = () =>
		memoryVectors({
			dimensions: 2,
			seed: [
				{ id: 'a', values: [1, 0], metadata: { kind: 'doc' } },
				{ id: 'b', values: [0, 1], metadata: { kind: 'page' } },
				{ id: 'c', values: [0.9, 0.1], namespace: 'other' }
			]
		});

	it('describes what it holds', async () => {
		expect(await index().describe()).toEqual({ dimensions: 2, count: 3, metric: 'cosine' });
	});

	it('ranks the nearest vector first', async () => {
		const answer = await index().query({ values: [1, 0], topK: 2 });
		expect(answer.matches[0]?.id).toBe('a');
	});

	it('keeps a namespace out of the default partition', async () => {
		const answer = await index().query({ values: [1, 0], topK: 10 });
		expect(answer.matches.map((m) => m.id)).not.toContain('c');
	});

	it('searches inside a namespace when one is named', async () => {
		const answer = await index().query({ values: [1, 0], topK: 10, namespace: 'other' });
		expect(answer.matches.map((m) => m.id)).toEqual(['c']);
	});

	it('applies a metadata filter', async () => {
		const answer = await index().query({ values: [1, 0], topK: 10, filter: { kind: 'page' } });
		expect(answer.matches.map((m) => m.id)).toEqual(['b']);
	});

	it('withholds values and metadata unless they are asked for', async () => {
		const plain = (await index().query({ values: [1, 0], topK: 1 })).matches[0];
		expect(plain?.values).toBeUndefined();
		expect(plain?.metadata).toBeUndefined();
	});

	it('returns them when they are', async () => {
		const full = (
			await index().query({
				values: [1, 0],
				topK: 1,
				returnValues: true,
				returnMetadata: 'all'
			})
		).matches[0];
		expect(full?.values).toEqual([1, 0]);
		expect(full?.metadata).toEqual({ kind: 'doc' });
	});

	it('honours topK', async () => {
		expect((await index().query({ values: [1, 0], topK: 1 })).matches).toHaveLength(1);
	});

	it('leaves an existing id alone on insert', async () => {
		const store = index();
		await store.insert([{ id: 'a', values: [0, 1] }]);
		expect((await store.getByIds(['a']))[0]?.values).toEqual([1, 0]);
	});

	it('replaces it on upsert, which is the whole difference', async () => {
		const store = index();
		await store.upsert([{ id: 'a', values: [0, 1] }]);
		expect((await store.getByIds(['a']))[0]?.values).toEqual([0, 1]);
	});

	it('deletes by id and reports how many went', async () => {
		const store = index();
		expect((await store.deleteByIds(['a', 'absent'])).count).toBe(1);
		expect(await store.getByIds(['a'])).toEqual([]);
	});

	it('refuses a record whose width does not match the index', async () => {
		await expect(index().insert([{ id: 'x', values: [1, 2, 3] }])).rejects.toThrow(
			/holds 2 dimensions and x carries 3/
		);
	});

	it('refuses a query of the wrong width rather than scoring nonsense', async () => {
		await expect(index().query({ values: [1] })).rejects.toThrow(/the query carries 1/);
	});

	it('ranks nearest-first under euclidean, where a smaller number is closer', async () => {
		const store = memoryVectors({
			dimensions: 2,
			metric: 'euclidean',
			seed: [
				{ id: 'near', values: [1, 0] },
				{ id: 'far', values: [10, 10] }
			]
		});
		expect((await store.query({ values: [1, 0] })).matches[0]?.id).toBe('near');
	});

	it('moves its mutation id on every write, so a caller can tell writes apart', async () => {
		const store = index();
		const first = await store.upsert([{ id: 'z', values: [1, 1] }]);
		const second = await store.deleteByIds(['z']);
		expect(first.mutationId).not.toBe(second.mutationId);
	});
});

describe('the vectorize slot on the adapter socket', () => {
	const set = (vectorize = memoryVectors({ dimensions: 2 })): AdapterSet => ({
		cache: memoryCacheStore(),
		kv: memoryKv(),
		r2: memoryKv(),
		queues: memoryKv(),
		assets: () => Promise.resolve(null),
		vectorize
	});
	const post = (path: string, body: unknown) =>
		new Request(`http://a/vectorize${path}`, { method: 'POST', body: JSON.stringify(body) });

	it('describes the index', async () => {
		const response = await handleAdapterRequest(
			set(),
			new Request('http://a/vectorize/describe')
		);
		expect(await response.json()).toMatchObject({ dimensions: 2, count: 0 });
	});

	it('round trips an insert and a query', async () => {
		const adapters = set();
		await handleAdapterRequest(
			adapters,
			post('/insert', { records: [{ id: 'a', values: [1, 0] }] })
		);
		const response = await handleAdapterRequest(adapters, post('/query', { values: [1, 0] }));
		const body = (await response.json()) as { matches: { id: string }[] };
		expect(body.matches[0]?.id).toBe('a');
	});

	it('gets and deletes by id', async () => {
		const adapters = set();
		await handleAdapterRequest(
			adapters,
			post('/upsert', { records: [{ id: 'a', values: [1, 0] }] })
		);
		const got = await handleAdapterRequest(adapters, post('/get', { ids: ['a'] }));
		expect((await got.json()) as unknown).toMatchObject({ records: [{ id: 'a' }] });
		const gone = await handleAdapterRequest(adapters, post('/delete', { ids: ['a'] }));
		expect((await gone.json()) as unknown).toMatchObject({ count: 1 });
	});

	it('answers 501 with no driver configured', async () => {
		const adapters = set();
		delete adapters.vectorize;
		const response = await handleAdapterRequest(adapters, post('/query', { values: [1, 0] }));
		expect(response.status).toBe(501);
	});

	it('turns an index refusal into a 400 carrying the reason', async () => {
		const response = await handleAdapterRequest(set(), post('/query', { values: [1, 2, 3] }));
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('the query carries 3');
	});

	it('answers 404 for a route the adapter does not serve', async () => {
		expect((await handleAdapterRequest(set(), post('/reindex', {}))).status).toBe(404);
	});

	it('answers 405 for a GET on a write route', async () => {
		const response = await handleAdapterRequest(
			set(),
			new Request('http://a/vectorize/insert')
		);
		expect(response.status).toBe(405);
	});
});
