import { capabilities, type Capabilities, type Driver } from './capabilities';

export interface CacheEntry {
	/** the serialised HTTP response workerd stored, headers and all */
	bytes: Uint8Array;
	/** epoch millis, or null where the entry has no expiry of its own */
	expiresAt: number | null;
}

export interface CacheStore extends Driver {
	get(key: string): Promise<CacheEntry | null>;
	put(key: string, entry: CacheEntry): Promise<void>;
	purge(key: string): Promise<boolean>;
	/** bytes currently held, for the thrashing tripwire */
	size(): Promise<number>;
}

/**
 * A memory tier in front of a slower store, plus single-flighting.
 *
 * Two properties, both measured rather than assumed.
 *
 * **The cache decides throughput.** The edge tier absorbs 82% of anonymous traffic before the
 * Durable Object hop; with an always-miss cache every request reaches a single-threaded object.
 * So a disk read per request on the hot path is worth removing, which is what the memory tier is.
 *
 * **A cold cache is a herd.** After a restart, concurrent misses for one key would each drive a
 * render. `inflight` collapses them onto one, which is the shape a green suite has missed here
 * before: eight concurrent requests rendering eight times.
 */
export function tieredCache(
	backing: CacheStore,
	options: { memoryBytes: number; now?: () => number } = { memoryBytes: 256 * 1024 * 1024 }
): CacheStore {
	const now = options.now ?? Date.now;
	const hot = new Map<string, CacheEntry>();
	const inflight = new Map<string, Promise<CacheEntry | null>>();
	let hotBytes = 0;

	const caps: Capabilities = capabilities({ ttl: true, pagedList: false });

	const evictIfNeeded = (): void => {
		// insertion-ordered Map, so the oldest key is the first one; a true LRU would need a
		// touch on every read and this is the hot path
		while (hotBytes > options.memoryBytes) {
			const oldest = hot.keys().next();
			if (oldest.done === true) break;
			const held = hot.get(oldest.value);
			hot.delete(oldest.value);
			hotBytes -= held?.bytes.length ?? 0;
		}
	};

	const remember = (key: string, entry: CacheEntry): void => {
		const existing = hot.get(key);
		if (existing !== undefined) hotBytes -= existing.bytes.length;
		hot.set(key, entry);
		hotBytes += entry.bytes.length;
		evictIfNeeded();
	};

	const fresh = (entry: CacheEntry): boolean =>
		entry.expiresAt === null || entry.expiresAt > now();

	return {
		id: () => `tiered(${backing.id()})`,
		label: () => `Memory tier over ${backing.label()}`,
		capabilities: () => caps,
		isReachable: () => backing.isReachable(),
		unreachableReason: () => backing.unreachableReason(),

		get: async (key) => {
			const held = hot.get(key);
			if (held !== undefined) {
				if (fresh(held)) return held;
				hot.delete(key);
				hotBytes -= held.bytes.length;
			}
			const running = inflight.get(key);
			if (running !== undefined) return running;

			const load = backing
				.get(key)
				.then((entry) => {
					if (entry !== null && fresh(entry)) {
						remember(key, entry);
						return entry;
					}
					return null;
				})
				.finally(() => {
					inflight.delete(key);
				});
			inflight.set(key, load);
			return load;
		},

		put: async (key, entry) => {
			remember(key, entry);
			await backing.put(key, entry);
		},

		purge: async (key) => {
			const held = hot.get(key);
			if (held !== undefined) {
				hot.delete(key);
				hotBytes -= held.bytes.length;
			}
			return backing.purge(key);
		},

		size: async () => backing.size()
	};
}

/** an in-process cache store, and the backing tier in the gate lane */
export function memoryCacheStore(now: () => number = Date.now): CacheStore {
	const store = new Map<string, CacheEntry>();
	return {
		id: () => 'memory',
		label: () => 'In-process memory',
		capabilities: () => capabilities({ ttl: true }),
		isReachable: () => Promise.resolve(true),
		unreachableReason: () => null,
		get: async (key) => {
			const held = store.get(key);
			if (held === undefined) return null;
			if (held.expiresAt !== null && held.expiresAt <= now()) {
				store.delete(key);
				return null;
			}
			return held;
		},
		put: async (key, entry) => {
			store.set(key, entry);
		},
		purge: async (key) => store.delete(key),
		size: async () => [...store.values()].reduce((n, e) => n + e.bytes.length, 0)
	};
}
