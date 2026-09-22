import { DatabaseSync } from 'node:sqlite';
import type { CacheEntry, CacheStore } from '../adapters/cache';
import { capabilities } from '../adapters/capabilities';

/**
 * The on-disk cache store.
 *
 * One SQLite file rather than a file per entry: an entry needs bytes, an expiry and a size, and a
 * file-per-entry store would need its own index and eviction pass to answer the same questions.
 * `tieredCache` puts the memory tier in front of this, so the disk read is off the hot path.
 */
export function fsCacheStore(path: string, now: () => number = Date.now): CacheStore {
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE IF NOT EXISTS cache (
			key TEXT PRIMARY KEY,
			value BLOB NOT NULL,
			expires_at INTEGER,
			bytes INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS cache_expires ON cache (expires_at);
	`);

	const selectOne = db.prepare('SELECT value, expires_at FROM cache WHERE key = ?');
	const upsert = db.prepare(
		'INSERT INTO cache (key, value, expires_at, bytes) VALUES (?, ?, ?, ?) ' +
			'ON CONFLICT(key) DO UPDATE SET value = excluded.value, ' +
			'expires_at = excluded.expires_at, bytes = excluded.bytes'
	);
	const removeOne = db.prepare('DELETE FROM cache WHERE key = ?');
	const totalBytes = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS n FROM cache');

	return {
		id: () => 'fs',
		label: () => 'On disk',
		capabilities: () => capabilities({ ttl: true }),
		isReachable: async () => {
			try {
				db.prepare('SELECT 1').get();
				return true;
			} catch {
				return false;
			}
		},
		unreachableReason: () => null,

		get: async (key): Promise<CacheEntry | null> => {
			const row = selectOne.get(key) as
				{ value: Uint8Array; expires_at: number | null } | undefined;
			if (row === undefined) return null;
			if (row.expires_at !== null && row.expires_at <= now()) {
				removeOne.run(key);
				return null;
			}
			return { bytes: new Uint8Array(row.value), expiresAt: row.expires_at };
		},

		put: async (key, entry) => {
			upsert.run(key, entry.bytes, entry.expiresAt, entry.bytes.length);
		},

		purge: async (key) => removeOne.run(key).changes > 0,

		size: async () => Number((totalBytes.get() as { n: number }).n)
	};
}
