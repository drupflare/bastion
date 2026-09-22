import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sqliteClient } from '../../../src/drivers/sqlite-sql';

function client() {
	return sqliteClient(join(mkdtempSync(join(tmpdir(), 'bastion-sql-')), 'd1.sqlite'));
}

describe('sqliteClient', () => {
	it('reports rows affected and the inserted id for a write', async () => {
		const db = client();
		await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)', []);
		const result = await db.query('INSERT INTO t (name) VALUES (?)', ['a']);
		expect(result.rowsAffected).toBe(1);
		expect(result.lastInsertId).toBe(1);
		expect(result.rows).toEqual([]);
	});

	it('returns rows for a read and no insert id', async () => {
		const db = client();
		await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)', []);
		await db.query('INSERT INTO t (name) VALUES (?)', ['a']);
		const result = await db.query('SELECT name FROM t', []);
		expect(result.rows).toEqual([{ name: 'a' }]);
		expect(result.lastInsertId).toBe(null);
	});

	it('binds a boolean as an integer, which is what sqlite stores', async () => {
		const db = client();
		await db.query('CREATE TABLE t (flag INTEGER)', []);
		await db.query('INSERT INTO t (flag) VALUES (?)', [true]);
		expect(await db.query('SELECT flag FROM t', [])).toMatchObject({ rows: [{ flag: 1 }] });
	});

	it('treats a WITH query as a read', async () => {
		const db = client();
		const result = await db.query('WITH x AS (SELECT 1 AS n) SELECT n FROM x', []);
		expect(result.rows).toEqual([{ n: 1 }]);
	});

	it('closes', async () => {
		const db = client();
		await db.close?.();
		await expect(db.query('SELECT 1', [])).rejects.toThrow();
	});
});
