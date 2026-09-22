import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEVERITY } from '../../src/audit/log';
import { QUARANTINE_STRIKES, ROLLBACK_DWELL_MS, RUNGS } from '../../src/health/ladder';

/**
 * bastion's repair vocabulary against the sibling it was copied from.
 *
 * `core/src/health/ladder.ts` says the ladder is inherited from `worker/src/ops/repair.ts` rather
 * than reinvented, and a second vocabulary for one ladder is the drift that costs a correctness
 * property: a rung bastion names and the worker does not is a repair that reaches nothing. The
 * docblock has claimed this spec exists since the ladder was written; it did not.
 *
 * Reading the source rather than importing it, because the sibling is a separate package with its
 * own build and bastion must not depend on it at runtime. `REQUIRE_SIBLINGS=1` with a checkout
 * beside this one, as drangler does.
 */
const root =
	process.env.SIBLING_WORKER ?? join(import.meta.dirname, '..', '..', '..', '..', 'worker');
const enabled = process.env.REQUIRE_SIBLINGS === '1';

function missing(): string | null {
	if (!enabled) return 'REQUIRE_SIBLINGS=1 is not set';
	if (!existsSync(join(root, 'src', 'ops', 'repair.ts'))) {
		throw new Error(`REQUIRE_SIBLINGS=1 but ${root} holds no worker checkout`);
	}
	return null;
}

const reason = missing();

/** the literal a `const` is assigned, read out of the source rather than evaluated */
function sourceOf(file: string): string {
	return readFileSync(join(root, 'src', 'ops', file), 'utf8');
}

function listOf(source: string, name: string): string[] {
	const at = source.indexOf(`export const ${name} = [`);
	if (at === -1) throw new Error(`${name} is not a list in the sibling any more`);
	const body = source.slice(at, source.indexOf(']', at));
	return [...body.matchAll(/'([a-z]+)'/g)].map((m) => m[1] as string);
}

/**
 * A numeric constant, read as text.
 *
 * The sibling writes `30 * 60_000`, so a product of numeric separators is understood and anything
 * else raises. Parsed rather than evaluated: this reads a file from another checkout, and nothing
 * that reads a file should be able to run what it finds there.
 */
function numberOf(source: string, name: string): number {
	const found = source.match(new RegExp(`export const ${name} = ([^;]+);`));
	if (found === null) throw new Error(`${name} is not a constant in the sibling any more`);
	const parts = (found[1] ?? '').replaceAll('_', '').split('*');
	return parts.reduce((total, part) => {
		const value = Number(part.trim());
		if (!Number.isFinite(value)) throw new Error(`${name} is not a plain number: ${found[1]}`);
		return total * value;
	}, 1);
}

describe.skipIf(reason !== null)(`the worker's repair vocabulary (${reason ?? 'enabled'})`, () => {
	it('names the same rungs, in the same order', () => {
		expect([...RUNGS]).toEqual(listOf(sourceOf('repair.ts'), 'RUNGS'));
	});

	it('quarantines after the same number of strikes', () => {
		expect(QUARANTINE_STRIKES).toBe(numberOf(sourceOf('repair.ts'), 'QUARANTINE_STRIKES'));
	});

	it('holds a quarantine for the same dwell before rolling back', () => {
		expect(ROLLBACK_DWELL_MS).toBe(numberOf(sourceOf('repair.ts'), 'ROLLBACK_DWELL_MS'));
	});

	/**
	 * bastion adds `debug` below `info` and must not renumber the four above it.
	 *
	 * The worker's table is `info(0) warn(1) error(2) critical(3)` and a ledger comparing severities
	 * across the two would read every level one place off if bastion shifted them to make room.
	 */
	it('keeps every severity the worker defines at the number the worker gives it', () => {
		const source = sourceOf('supervisor.ts');
		const block = source.slice(source.indexOf('export const SEVERITY = {'));
		for (const [, level, value] of block
			.slice(0, block.indexOf('}'))
			.matchAll(/(\w+): (-?\d+)/g)) {
			expect(SEVERITY[level as 'info'], `${String(level)} moved`).toBe(Number(value));
		}
	});

	it('puts debug below all of them rather than renumbering to make room', () => {
		expect(SEVERITY.debug).toBeLessThan(SEVERITY.info);
	});
});
