import { describe, expect, it } from 'vitest';
import { memoryCacheStore, tieredCache, type CacheStore } from '../../../src/adapters/cache';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const entry = (s: string, expiresAt: number | null = null) => ({ bytes: enc(s), expiresAt });

/** a backing store that counts reads and can be held open, so the herd is observable */
function countingStore(): CacheStore & { reads: number; release: () => void } {
	const inner = memoryCacheStore();
	let gate: Promise<void> = Promise.resolve();
	let open: (() => void) | null = null;
	const self = {
		...inner,
		reads: 0,
		release: () => {
			open?.();
			open = null;
		},
		hold: () => {
			gate = new Promise<void>((r) => {
				open = r;
			});
		},
		get: async (key: string) => {
			self.reads++;
			await gate;
			return inner.get(key);
		}
	};
	return self as CacheStore & { reads: number; release: () => void; hold: () => void };
}

describe('tieredCache', () => {
	it('serves from the memory tier without touching the backing store', async () => {
		const backing = countingStore();
		const cache = tieredCache(backing, { memoryBytes: 1024 });
		await cache.put('a', entry('one'));
		expect(await cache.get('a')).not.toBe(null);
		// the put populated the hot tier, so no read reached the backing store at all
		expect(backing.reads).toBe(0);
	});

	it('falls through to the backing store on a cold key', async () => {
		const backing = memoryCacheStore();
		await backing.put('a', entry('one'));
		const cache = tieredCache(backing, { memoryBytes: 1024 });
		expect(new TextDecoder().decode((await cache.get('a'))!.bytes)).toBe('one');
	});

	// a cold cache after a restart is a thundering herd at the object; eight concurrent misses
	// must drive one load, not eight
	it('single-flights concurrent misses for one key', async () => {
		const backing = countingStore() as ReturnType<typeof countingStore> & { hold(): void };
		await backing.put('a', entry('one'));
		backing.hold();
		const cache = tieredCache(backing, { memoryBytes: 1024 });
		const all = Promise.all(Array.from({ length: 8 }, () => cache.get('a')));
		backing.release();
		const results = await all;
		expect(results.every((r) => r !== null)).toBe(true);
		expect(backing.reads).toBe(1);
	});

	it('does not serve an expired entry from the memory tier', async () => {
		let clock = 0;
		const backing = memoryCacheStore(() => clock);
		const cache = tieredCache(backing, { memoryBytes: 1024, now: () => clock });
		await cache.put('a', entry('one', 100));
		clock = 100;
		expect(await cache.get('a')).toBe(null);
	});

	it('evicts from the memory tier once it is over budget', async () => {
		const backing = memoryCacheStore();
		const cache = tieredCache(backing, { memoryBytes: 8 });
		await cache.put('a', entry('aaaa'));
		await cache.put('b', entry('bbbb'));
		await cache.put('c', entry('cccc'));
		// evicted from memory but still in the backing store, so it is a miss upward not a loss
		expect(await cache.get('a')).not.toBe(null);
	});

	it('purges from both tiers', async () => {
		const backing = memoryCacheStore();
		const cache = tieredCache(backing, { memoryBytes: 1024 });
		await cache.put('a', entry('one'));
		expect(await cache.purge('a')).toBe(true);
		expect(await cache.get('a')).toBe(null);
		expect(await backing.get('a')).toBe(null);
	});

	it('reports the backing store reachability rather than its own', async () => {
		const backing = memoryCacheStore();
		const cache = tieredCache(backing, { memoryBytes: 1024 });
		expect(await cache.isReachable()).toBe(true);
		expect(cache.id()).toBe('tiered(memory)');
	});
});
