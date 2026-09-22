import { capabilities } from '../adapters/capabilities';
import {
	placeholders,
	type SqlClient,
	type SqlDialect,
	type SqlResult,
	type SqlStore,
	type SqlValue
} from '../adapters/sql';

/**
 * A SQL store over any client satisfying the contract.
 *
 * One implementation for postgres, mysql and mariadb, because the difference between them that
 * bastion can see is the placeholder syntax and nothing else. `batch` is applied in order and
 * stops at the first failure rather than continuing, so a caller never has to work out which half
 * of its statements landed.
 */
export function sqlStore(dialect: SqlDialect, client: SqlClient, label?: string): SqlStore {
	let unreachable: string | null = null;
	return {
		id: () => dialect,
		label: () => label ?? dialect,
		dialect: () => dialect,
		capabilities: () => capabilities({ pagedList: true, batchDelete: true }),
		isReachable: async () => {
			try {
				await client.query('SELECT 1', []);
				unreachable = null;
				return true;
			} catch (e) {
				unreachable = e instanceof Error ? e.message : String(e);
				return false;
			}
		},
		unreachableReason: () => unreachable,
		query: (sql: string, params: SqlValue[] = []) =>
			client.query(placeholders(sql, dialect), params),
		batch: async (statements) => {
			const out: SqlResult[] = [];
			for (const statement of statements) {
				out.push(
					await client.query(placeholders(statement.sql, dialect), statement.params ?? [])
				);
			}
			return out;
		}
	};
}
