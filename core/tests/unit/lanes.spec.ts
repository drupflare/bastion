import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gate } from '../e2e/support/gate';

/**
 * The `REQUIRE_*` keys, checked from the gate lane because nothing else can check them.
 *
 * Each key selects an e2e lane, and a lane that never runs looks exactly like a lane that passed.
 * The two directions here are the same rule `check:reachability` applies to tripwires: a key no
 * spec reads is stale documentation, and a key no workflow sets is a lane CI never runs.
 */
const repo = join(import.meta.dirname, '..', '..', '..');
const e2e = join(repo, 'core', 'tests', 'e2e');

const specs = readdirSync(e2e)
	.filter((name) => name.endsWith('.spec.ts'))
	.map((name) => ({ name, source: readFileSync(join(e2e, name), 'utf8') }));

/** the keys one file gates on, taken from its `gate()` call rather than from any mention of one */
function gatedOn(source: string): string[] {
	const call = /gate\(\s*(?:\[([^\]]*)\]|'([A-Z_]+)')/.exec(source);
	if (call === null) return [];
	if (call[2] !== undefined) return [call[2]];
	return [...(call[1] as string).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] as string);
}

const gates = new Map(specs.map((spec) => [spec.name, gatedOn(spec.source)]));
const keys = [...new Set([...gates.values()].flat())].filter((key) => key.startsWith('REQUIRE_'));

const readme = readFileSync(join(repo, 'README.md'), 'utf8');
const workflows = readdirSync(join(repo, '.github', 'workflows'))
	.map((name) => readFileSync(join(repo, '.github', 'workflows', name), 'utf8'))
	.join('\n');

describe('the e2e gate keys', () => {
	it('gates every lane, so none of them runs on a laptop that cannot host it', () => {
		for (const [name, on] of gates) expect(on, name).not.toHaveLength(0);
	});

	it('documents every key it reads', () => {
		for (const key of keys) expect(readme, key).toContain(`${key}=1 bun run test`);
	});

	it('reads every key it documents', () => {
		const documented = [...readme.matchAll(/(REQUIRE_[A-Z_]+)=1 bun run test/g)].map(
			(match) => match[1] as string
		);
		for (const key of new Set(documented)) expect(keys, key).toContain(key);
	});

	it('runs every key in a workflow', () => {
		for (const key of keys) expect(workflows, key).toContain(`${key}=1`);
	});
});

describe('gate', () => {
	it('names the key it wanted when it is not set', () => {
		expect(gate('REQUIRE_X', [], {})).toBe('REQUIRE_X=1 is not set');
	});

	it('does not accept a value other than 1, so `=0` is off rather than set', () => {
		expect(gate('REQUIRE_X', [], { REQUIRE_X: '0' })).toBe('REQUIRE_X=1 is not set');
		expect(gate('REQUIRE_X', [], { REQUIRE_X: 'true' })).toBe('REQUIRE_X=1 is not set');
	});

	it('runs the lane once the key is set', () => {
		expect(gate('REQUIRE_X', [], { REQUIRE_X: '1' })).toBe(null);
	});

	it('throws rather than skipping when a prerequisite is missing under its own key', () => {
		expect(() =>
			gate('REQUIRE_X', [{ what: 'BASTION_BINARY (/nope) is not a file', present: false }], {
				REQUIRE_X: '1'
			})
		).toThrow('REQUIRE_X=1 but BASTION_BINARY (/nope) is not a file');
	});

	it('leaves a missing prerequisite alone while the key is unset', () => {
		expect(gate('REQUIRE_X', [{ what: 'nothing is installed', present: false }], {})).toBe(
			'REQUIRE_X=1 is not set'
		);
	});

	it('checks every prerequisite, not only the first', () => {
		expect(() =>
			gate(
				'REQUIRE_X',
				[
					{ what: 'the first is here', present: true },
					{ what: 'the second is absent', present: false }
				],
				{ REQUIRE_X: '1' }
			)
		).toThrow('the second is absent');
	});

	it('takes alternates, which is how one lane answers to two flags', () => {
		expect(gate(['REQUIRE_DOCKER', 'BASTION_E2E_INTEGRATION'], [], {})).toBe(
			'REQUIRE_DOCKER=1 or BASTION_E2E_INTEGRATION=1 is not set'
		);
		expect(
			gate(['REQUIRE_DOCKER', 'BASTION_E2E_INTEGRATION'], [], { REQUIRE_DOCKER: '1' })
		).toBe(null);
		expect(
			gate(['REQUIRE_DOCKER', 'BASTION_E2E_INTEGRATION'], [], {
				BASTION_E2E_INTEGRATION: '1'
			})
		).toBe(null);
	});

	it('blames the key that is actually set', () => {
		expect(() =>
			gate(
				['REQUIRE_DOCKER', 'BASTION_E2E_INTEGRATION'],
				[{ what: 'minio is not up', present: false }],
				{ BASTION_E2E_INTEGRATION: '1' }
			)
		).toThrow('BASTION_E2E_INTEGRATION=1 but minio is not up');
	});
});
