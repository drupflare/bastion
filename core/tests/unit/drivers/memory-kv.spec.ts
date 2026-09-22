import { describe, expect, it } from 'vitest';
import { memoryKv } from '../../../src/drivers/memory-kv';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('memoryKv', () => {
	it('round-trips a value', async () => {
		const kv = memoryKv();
		await kv.put('a', enc('one'));
		expect(dec((await kv.get('a'))!.bytes)).toBe('one');
	});

	it('answers null for an absent key rather than raising', async () => {
		expect(await memoryKv().get('nope')).toBe(null);
	});

	it('honours a conditional write by leaving the existing value alone', async () => {
		const kv = memoryKv();
		await kv.put('a', enc('first'));
		await kv.put('a', enc('second'), { ifAbsent: true });
		expect(dec((await kv.get('a'))!.bytes)).toBe('first');
	});

	it('expires on read, at the instant, not after it', async () => {
		let clock = 0;
		const kv = memoryKv(() => clock);
		await kv.put('a', enc('x'), { expiresAt: 100 });
		clock = 99;
		expect(await kv.get('a')).not.toBe(null);
		clock = 100;
		expect(await kv.get('a')).toBe(null);
	});

	it('counts only the keys it actually removed', async () => {
		const kv = memoryKv();
		await kv.put('a', enc('x'));
		expect(await kv.delete(['a', 'b'])).toBe(1);
	});

	it('lists by prefix in key order', async () => {
		const kv = memoryKv();
		for (const k of ['b:2', 'a:1', 'b:1']) await kv.put(k, enc(k));
		const page = await kv.list('b:');
		expect(page.keys.map((k) => k.name)).toEqual(['b:1', 'b:2']);
		expect(page.cursor).toBe(null);
	});

	it('pages, and the cursor resumes after the last key returned', async () => {
		const kv = memoryKv();
		for (const k of ['a', 'b', 'c']) await kv.put(k, enc(k));
		const first = await kv.list('', null, 2);
		expect(first.keys.map((k) => k.name)).toEqual(['a', 'b']);
		expect(first.cursor).toBe('b');
		const second = await kv.list('', first.cursor, 2);
		expect(second.keys.map((k) => k.name)).toEqual(['c']);
		expect(second.cursor).toBe(null);
	});

	it('omits an expired key from a listing', async () => {
		let clock = 0;
		const kv = memoryKv(() => clock);
		await kv.put('a', enc('x'), { expiresAt: 10 });
		await kv.put('b', enc('y'));
		clock = 20;
		expect((await kv.list()).keys.map((k) => k.name)).toEqual(['b']);
	});

	it('declares what it can do', async () => {
		const kv = memoryKv();
		expect(kv.id()).toBe('memory');
		expect(kv.capabilities().ttl).toBe(true);
		expect(await kv.isReachable()).toBe(true);
		expect(kv.unreachableReason()).toBe(null);
	});
});
