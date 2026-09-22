import { describe, expect, it } from 'vitest';
import { sqliteKv } from '../../../src/drivers/sqlite-kv';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** `:memory:` keeps the gate hermetic: no file, no cleanup, no shared state between specs */
const kv = (now?: () => number) => sqliteKv(':memory:', now === undefined ? {} : { now });

describe('sqliteKv', () => {
	it('round-trips bytes rather than a decoded string', async () => {
		const store = kv();
		const bytes = new Uint8Array([0, 255, 128, 0]);
		await store.put('a', bytes);
		const held = await store.get('a');
		// a driver that encoded on read would return something else for a binary member
		expect(Array.from(held!.bytes)).toEqual([0, 255, 128, 0]);
	});

	it('answers null for an absent key', async () => {
		expect(await kv().get('nope')).toBe(null);
	});

	it('overwrites on a plain put', async () => {
		const store = kv();
		await store.put('a', enc('first'));
		await store.put('a', enc('second'));
		expect(dec((await store.get('a'))!.bytes)).toBe('second');
	});

	it('leaves the existing value alone on a conditional put', async () => {
		const store = kv();
		await store.put('a', enc('first'));
		await store.put('a', enc('second'), { ifAbsent: true });
		expect(dec((await store.get('a'))!.bytes)).toBe('first');
	});

	it('round-trips metadata', async () => {
		const store = kv();
		await store.put('a', enc('x'), { metadata: { etag: 'w/1' } });
		expect((await store.get('a'))?.metadata).toEqual({ etag: 'w/1' });
	});

	it('expires on read at the instant', async () => {
		let clock = 0;
		const store = kv(() => clock);
		await store.put('a', enc('x'), { expiresAt: 100 });
		clock = 99;
		expect(await store.get('a')).not.toBe(null);
		clock = 100;
		expect(await store.get('a')).toBe(null);
	});

	it('counts only what it removed', async () => {
		const store = kv();
		await store.put('a', enc('x'));
		expect(await store.delete(['a', 'b'])).toBe(1);
	});

	it('lists by prefix in key order', async () => {
		const store = kv();
		for (const k of ['b:2', 'a:1', 'b:1']) await store.put(k, enc(k));
		expect((await store.list('b:')).keys.map((k) => k.name)).toEqual(['b:1', 'b:2']);
	});

	// a LIKE prefix would need escaping for these; the range query does not
	it('handles a prefix containing LIKE wildcards', async () => {
		const store = kv();
		await store.put('100%/a', enc('x'));
		await store.put('100x/a', enc('y'));
		const page = await store.list('100%/');
		expect(page.keys.map((k) => k.name)).toEqual(['100%/a']);
	});

	it('handles an underscore in a prefix', async () => {
		const store = kv();
		await store.put('a_b', enc('x'));
		await store.put('axb', enc('y'));
		expect((await store.list('a_')).keys.map((k) => k.name)).toEqual(['a_b']);
	});

	it('pages, resuming after the last key returned', async () => {
		const store = kv();
		for (const k of ['a', 'b', 'c']) await store.put(k, enc(k));
		const first = await store.list('', null, 2);
		expect(first.keys.map((k) => k.name)).toEqual(['a', 'b']);
		expect(first.cursor).toBe('b');
		const second = await store.list('', first.cursor, 2);
		expect(second.keys.map((k) => k.name)).toEqual(['c']);
		expect(second.cursor).toBe(null);
	});

	it('omits an expired key from a listing', async () => {
		let clock = 0;
		const store = kv(() => clock);
		await store.put('a', enc('x'), { expiresAt: 10 });
		await store.put('b', enc('y'));
		clock = 20;
		expect((await store.list()).keys.map((k) => k.name)).toEqual(['b']);
	});

	it('refuses a value over a declared size limit rather than truncating', async () => {
		const store = sqliteKv(':memory:', { maxValueBytes: 2 });
		await expect(store.put('a', enc('too long'))).rejects.toThrow(/byte limit/);
	});

	it('declares what it can do and answers reachable', async () => {
		const store = kv();
		expect(store.id()).toBe('sqlite');
		expect(store.capabilities().conditionalWrite).toBe(true);
		expect(await store.isReachable()).toBe(true);
	});
});
