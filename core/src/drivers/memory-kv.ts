import { capabilities, type Capabilities } from '../adapters/capabilities';
import {
	assertCanHonour,
	isExpired,
	type KeyValueStore,
	type ListPage,
	type StoredValue
} from '../adapters/store';

/**
 * An in-process key/value store.
 *
 * Real enough to drive the gate lane and to serve a single-node install that accepts losing its
 * KV on restart; it is never the default, because the drupflare bundle treats KV as an artifact
 * tier that survives one.
 */
export function memoryKv(now: () => number = Date.now): KeyValueStore {
	const store = new Map<string, StoredValue>();
	const caps: Capabilities = capabilities({
		conditionalWrite: true,
		batchDelete: true,
		pagedList: true,
		ttl: true
	});

	return {
		id: () => 'memory',
		label: () => 'In-process memory',
		capabilities: () => caps,
		isReachable: () => Promise.resolve(true),
		unreachableReason: () => null,

		get: async (key) => {
			const held = store.get(key);
			if (held === undefined) return null;
			if (isExpired(held, now())) {
				store.delete(key);
				return null;
			}
			return held;
		},

		put: async (key, bytes, options) => {
			assertCanHonour('memory', caps, options, bytes);
			if (options?.ifAbsent === true && store.has(key)) return;
			store.set(key, {
				bytes,
				expiresAt: options?.expiresAt ?? null,
				...(options?.metadata === undefined ? {} : { metadata: options.metadata })
			});
		},

		delete: async (keys) => {
			let removed = 0;
			for (const key of keys) if (store.delete(key)) removed++;
			return removed;
		},

		list: async (prefix = '', cursor = null, limit = 1000): Promise<ListPage> => {
			const at = now();
			const all = [...store.entries()]
				.filter(([key, value]) => key.startsWith(prefix) && !isExpired(value, at))
				.map(([name, value]) => ({ name, expiresAt: value.expiresAt }))
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
			const start = cursor === null ? 0 : all.findIndex((e) => e.name > cursor);
			const from = start < 0 ? all.length : start;
			const page = all.slice(from, from + limit);
			const last = page.at(-1);
			return {
				keys: page,
				cursor: from + limit < all.length && last !== undefined ? last.name : null
			};
		}
	};
}
