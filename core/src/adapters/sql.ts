import { BastionError } from '../errors';
import type { Driver } from './capabilities';

export type SqlValue = string | number | boolean | null | Uint8Array;

export interface SqlResult {
	rows: Record<string, SqlValue>[];
	rowsAffected: number;
	lastInsertId: number | string | null;
}

/**
 * The shape a SQL client has to satisfy.
 *
 * Structural, so `postgres`, `mysql2`, `mariadb` or a pool wrapper all fit and bastion depends on
 * none of them. One method rather than a query builder: the engine only ever sends a statement and
 * its parameters, and anything richer would be a second dialect surface to keep correct.
 */
export interface SqlClient {
	query(sql: string, params: SqlValue[]): Promise<SqlResult>;
	close?(): Promise<void>;
}

export const SQL_DIALECTS = ['sqlite', 'postgres', 'mysql', 'mariadb'] as const;
export type SqlDialect = (typeof SQL_DIALECTS)[number];

/**
 * Rewrites positional placeholders for the dialect.
 *
 * This is the ONLY dialect translation bastion does, and it is deliberately that small. drangler
 * owns the SQL converter and paid for it: seven converter bugs shipped past a green unit suite and
 * were found the first time converted SQL met a real database. A second converter here would be a
 * second copy of that lesson, so anything past placeholders is the caller's statement to get right.
 *
 * Quoted literals are skipped, because a `?` inside a string is data.
 */
export function placeholders(sql: string, dialect: SqlDialect): string {
	if (dialect !== 'postgres') return sql;
	let out = '';
	let n = 0;
	let quote: string | null = null;
	for (let i = 0; i < sql.length; i++) {
		const char = sql[i] as string;
		if (quote !== null) {
			out += char;
			if (char === quote) quote = null;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			out += char;
			continue;
		}
		if (char === '?') {
			n += 1;
			out += `$${n}`;
			continue;
		}
		out += char;
	}
	return out;
}

export interface SqlStore extends Driver {
	dialect(): SqlDialect;
	query(sql: string, params?: SqlValue[]): Promise<SqlResult>;
	batch(statements: { sql: string; params?: SqlValue[] }[]): Promise<SqlResult[]>;
}

/** the request body the D1 adapter accepts, which bastion defines because D1 has no capnp binding */
export interface SqlRequest {
	sql: string;
	params?: SqlValue[];
	/** several statements in one call, applied in order */
	batch?: { sql: string; params?: SqlValue[] }[];
}

export function parseSqlRequest(body: unknown): SqlRequest {
	if (typeof body !== 'object' || body === null) {
		throw new BastionError('usage', 'the sql adapter expects a JSON object');
	}
	const record = body as Record<string, unknown>;
	if (Array.isArray(record.batch)) return { sql: '', batch: record.batch as SqlRequest['batch'] };
	if (typeof record.sql !== 'string' || record.sql.trim() === '') {
		throw new BastionError('usage', 'the sql adapter expects a non-empty `sql`');
	}
	return {
		sql: record.sql,
		params: Array.isArray(record.params) ? (record.params as SqlValue[]) : []
	};
}
