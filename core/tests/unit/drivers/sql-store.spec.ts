import { describe, expect, it } from 'vitest';
import { parseSqlRequest, placeholders, type SqlClient } from '../../../src/adapters/sql';
import { sqlStore } from '../../../src/drivers/sql-store';

function recordingClient(): SqlClient & { seen: { sql: string; params: unknown[] }[] } {
	const seen: { sql: string; params: unknown[] }[] = [];
	return {
		seen,
		query: async (sql, params) => {
			seen.push({ sql, params });
			return { rows: [], rowsAffected: 1, lastInsertId: null };
		}
	};
}

describe('placeholders', () => {
	it('leaves sqlite and mysql alone', () => {
		expect(placeholders('SELECT ? , ?', 'sqlite')).toBe('SELECT ? , ?');
		expect(placeholders('SELECT ? , ?', 'mysql')).toBe('SELECT ? , ?');
		expect(placeholders('SELECT ? , ?', 'mariadb')).toBe('SELECT ? , ?');
	});

	it('numbers them from one for postgres', () => {
		expect(placeholders('SELECT * FROM t WHERE a = ? AND b = ?', 'postgres')).toBe(
			'SELECT * FROM t WHERE a = $1 AND b = $2'
		);
	});

	it('leaves a question mark inside a string literal alone, because it is data', () => {
		expect(placeholders("SELECT '?' , ?", 'postgres')).toBe("SELECT '?' , $1");
		expect(placeholders('SELECT "a?b" , ?', 'postgres')).toBe('SELECT "a?b" , $1');
	});
});

describe('sqlStore', () => {
	it('rewrites placeholders on the way to a postgres client', async () => {
		const client = recordingClient();
		await sqlStore('postgres', client).query('SELECT ?', ['a']);
		expect(client.seen[0]?.sql).toBe('SELECT $1');
	});

	it('applies a batch in order', async () => {
		const client = recordingClient();
		await sqlStore('sqlite', client).batch([{ sql: 'A' }, { sql: 'B' }]);
		expect(client.seen.map((s) => s.sql)).toEqual(['A', 'B']);
	});

	it('stops at the first failure rather than leaving a caller to work out what landed', async () => {
		const client: SqlClient = {
			query: async (sql) => {
				if (sql === 'B') throw new Error('constraint');
				return { rows: [], rowsAffected: 1, lastInsertId: null };
			}
		};
		await expect(
			sqlStore('sqlite', client).batch([{ sql: 'A' }, { sql: 'B' }, { sql: 'C' }])
		).rejects.toThrow(/constraint/);
	});

	it('reports unreachable with the reason from the client', async () => {
		const client: SqlClient = { query: async () => Promise.reject(new Error('no route')) };
		const store = sqlStore('mysql', client);
		expect(await store.isReachable()).toBe(false);
		expect(store.unreachableReason()).toContain('no route');
	});

	it('names its dialect, which is what the engine branches on', () => {
		expect(sqlStore('mariadb', recordingClient()).dialect()).toBe('mariadb');
	});
});

describe('parseSqlRequest', () => {
	it('reads a single statement and its parameters', () => {
		expect(parseSqlRequest({ sql: 'SELECT 1', params: [1] })).toEqual({
			sql: 'SELECT 1',
			params: [1]
		});
	});

	it('reads a batch', () => {
		const parsed = parseSqlRequest({ batch: [{ sql: 'A' }] });
		expect(parsed.batch).toHaveLength(1);
	});

	it('refuses a body that is not an object', () => {
		expect(() => parseSqlRequest('SELECT 1')).toThrow(/JSON object/);
		expect(() => parseSqlRequest(null)).toThrow(/JSON object/);
	});

	it('refuses an empty statement rather than sending it', () => {
		expect(() => parseSqlRequest({ sql: '   ' })).toThrow(/non-empty/);
		expect(() => parseSqlRequest({})).toThrow(/non-empty/);
	});
});
