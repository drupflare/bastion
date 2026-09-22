import { DatabaseSync } from 'node:sqlite';
import type { SqlClient, SqlResult, SqlValue } from '../adapters/sql';

/**
 * The SQL client contract over `node:sqlite`.
 *
 * The default d1 driver, and the one an operator gets without provisioning anything. It is the
 * same module the KV driver uses, so a bastion install carries one SQLite rather than two.
 */
export function sqliteClient(path: string): SqlClient & { db: DatabaseSync } {
	const db = new DatabaseSync(path);
	return {
		db,
		query: async (sql: string, params: SqlValue[] = []): Promise<SqlResult> => {
			const statement = db.prepare(sql);
			const bound = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
			if (/^\s*(select|with|pragma)/i.test(sql)) {
				return {
					rows: statement.all(...bound) as Record<string, SqlValue>[],
					rowsAffected: 0,
					lastInsertId: null
				};
			}
			const result = statement.run(...bound);
			return {
				rows: [],
				rowsAffected: Number(result.changes),
				lastInsertId:
					result.lastInsertRowid === undefined ? null : Number(result.lastInsertRowid)
			};
		},
		close: async () => {
			db.close();
		}
	};
}
