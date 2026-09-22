import { describe, expect, it } from 'vitest';
import { fsCacheStore } from '../../../src/drivers/fs-cache';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const store = (now?: () => number) => fsCacheStore(':memory:', now);

describe('fsCacheStore', () => {
	it('round-trips an entry', async () => {
		const cache = store();
		await cache.put('a', { bytes: enc('one'), expiresAt: null });
		expect(new TextDecoder().decode((await cache.get('a'))!.bytes)).toBe('one');
	});

	it('answers null for an absent key', async () => {
		expect(await store().get('a')).toBe(null);
	});

	it('expires on read and removes the row', async () => {
		let clock = 0;
		const cache = store(() => clock);
		await cache.put('a', { bytes: enc('x'), expiresAt: 50 });
		clock = 50;
		expect(await cache.get('a')).toBe(null);
		expect(await cache.size()).toBe(0);
	});

	it('reports the bytes it holds, for the thrashing tripwire', async () => {
		const cache = store();
		await cache.put('a', { bytes: enc('aaaa'), expiresAt: null });
		await cache.put('b', { bytes: enc('bb'), expiresAt: null });
		expect(await cache.size()).toBe(6);
	});

	it('does not double-count an overwrite', async () => {
		const cache = store();
		await cache.put('a', { bytes: enc('aaaa'), expiresAt: null });
		await cache.put('a', { bytes: enc('bb'), expiresAt: null });
		expect(await cache.size()).toBe(2);
	});

	it('purges, and says whether it held the key', async () => {
		const cache = store();
		await cache.put('a', { bytes: enc('x'), expiresAt: null });
		expect(await cache.purge('a')).toBe(true);
		expect(await cache.purge('a')).toBe(false);
	});

	it('is reachable and names itself', async () => {
		const cache = store();
		expect(cache.id()).toBe('fs');
		expect(await cache.isReachable()).toBe(true);
	});
});
