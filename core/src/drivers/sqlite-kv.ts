import { DatabaseSync } from 'node:sqlite';
import { capabilities, type Capabilities } from '../adapters/capabilities';
import {
	assertCanHonour,
	type KeyValueStore,
	type ListPage,
	type PutOptions,
	type StoredValue
} from '../adapters/store';

/**
 * A key/value store on SQLite, and the default for KV, R2 and queues.
 *
 * `node:sqlite` rather than `bun:sqlite` on purpose: it resolves under node AND under bun 1.4, so
 * one implementation serves the gate lane, the compiled binary and a node install. (A sibling
 * memory records `node:sqlite` as absent from bun; that was true of an older bun and is not now.)
 */
export function sqliteKv(
	path: string,
	options: { now?: () => number; maxValueBytes?: number | null } = {}
): KeyValueStore {
	const now = options.now ?? Date.now;
	const db = new DatabaseSync(path);
	db.exec(`
		CREATE TABLE IF NOT EXISTS kv (
			key TEXT PRIMARY KEY,
			value BLOB NOT NULL,
			expires_at INTEGER,
			metadata TEXT
		);
		CREATE INDEX IF NOT EXISTS kv_expires ON kv (expires_at);
	`);

	const caps: Capabilities = capabilities({
		conditionalWrite: true,
		batchDelete: true,
		pagedList: true,
		ttl: true,
		maxValueBytes: options.maxValueBytes ?? null
	});

	const selectOne = db.prepare('SELECT value, expires_at, metadata FROM kv WHERE key = ?');
	const insert = db.prepare(
		'INSERT INTO kv (key, value, expires_at, metadata) VALUES (?, ?, ?, ?) ' +
			'ON CONFLICT(key) DO UPDATE SET value = excluded.value, ' +
			'expires_at = excluded.expires_at, metadata = excluded.metadata'
	);
	const insertIfAbsent = db.prepare(
		'INSERT OR IGNORE INTO kv (key, value, expires_at, metadata) VALUES (?, ?, ?, ?)'
	);
	const removeOne = db.prepare('DELETE FROM kv WHERE key = ?');

	const alive = (expiresAt: number | null): boolean => expiresAt === null || expiresAt > now();

	return {
		id: () => 'sqlite',
		label: () => 'SQLite',
		capabilities: () => caps,
		isReachable: async () => {
			try {
				db.prepare('SELECT 1').get();
				return true;
			} catch {
				return false;
			}
		},
		unreachableReason: () => null,

		get: async (key): Promise<StoredValue | null> => {
			const row = selectOne.get(key) as
				| { value: Uint8Array; expires_at: number | null; metadata: string | null }
				| undefined;
			if (row === undefined) return null;
			if (!alive(row.expires_at)) {
				removeOne.run(key);
				return null;
			}
			return {
				bytes: new Uint8Array(row.value),
				expiresAt: row.expires_at,
				...(row.metadata === null
					? {}
					: { metadata: JSON.parse(row.metadata) as Record<string, string> })
			};
		},

		put: async (key, bytes, options?: PutOptions) => {
			assertCanHonour('sqlite', caps, options, bytes);
			const meta = options?.metadata === undefined ? null : JSON.stringify(options.metadata);
			const statement = options?.ifAbsent === true ? insertIfAbsent : insert;
			statement.run(key, bytes, options?.expiresAt ?? null, meta);
		},

		delete: async (keys) => {
			let removed = 0;
			for (const key of keys) removed += removeOne.run(key).changes > 0 ? 1 : 0;
			return removed;
		},

		list: async (prefix = '', cursor = null, limit = 1000): Promise<ListPage> => {
			// LIKE would need escaping for a key holding % or _; a range on the prefix does not
			const upper = `${prefix}￿`;
			const rows = db
				.prepare(
					'SELECT key, expires_at FROM kv WHERE key >= ? AND key < ? AND key > ? ' +
						'ORDER BY key LIMIT ?'
				)
				.all(prefix, upper, cursor ?? '', limit + 1) as {
				key: string;
				expires_at: number | null;
			}[];
			const live = rows.filter((r) => alive(r.expires_at));
			const page = live.slice(0, limit);
			const last = page.at(-1);
			return {
				keys: page.map((r) => ({ name: r.key, expiresAt: r.expires_at })),
				cursor: live.length > limit && last !== undefined ? last.key : null
			};
		}
	};
}
