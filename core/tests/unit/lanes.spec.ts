import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gate } from '../e2e/support/gate';

/**
 * The `REQUIRE_*` keys, checked from the gate lane because nothing else can check them.
 *
 * Each key selects an e2e lane, and a lane that never runs looks exactly like a lane that passed.
 * The two directions here are the same rule `check:reachability` applies to tripwires: a key no
 * spec reads is stale documentation, and a key no workflow sets is a lane CI never runs, unless
 * the hardware is one no runner has and the exemption below says which.
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

/**
 * Lanes no hosted runner can run, with the mechanism each one needs.
 *
 * An exemption is not a way to quiet the rule below; it is the statement that CI cannot host the
 * lane at all, so the lane is run by hand and its result is recorded rather than inferred. A key
 * listed here that a workflow DOES set is a stale exemption, which the second direction catches.
 *
 * `REQUIRE_KVM` needs `/dev/kvm`, and a shared runner is itself a VM that does not pass it through:
 * a hypervisor connection there fails on permission rather than running slowly. GitHub's LARGER
 * runners do hardware acceleration, which is what the Android emulator action relies on, so the
 * capability reads as available until the label is the free one.
 */
const HOSTED_RUNNER_CANNOT: Record<string, string> = {
	REQUIRE_KVM: '/dev/kvm'
};

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

	it('runs every key in a workflow, or states why no runner can host it', () => {
		for (const key of keys) {
			if (key in HOSTED_RUNNER_CANNOT) continue;
			expect(workflows, key).toContain(`${key}=1`);
		}
	});

	/** an exemption for a lane CI turns out to run is documentation of a rule nobody applies */
	it('drops an exemption once a workflow runs that lane after all', () => {
		for (const key of Object.keys(HOSTED_RUNNER_CANNOT)) {
			expect(workflows, key).not.toContain(`${key}=1`);
		}
	});

	it('exempts only a key some lane actually gates on', () => {
		for (const key of Object.keys(HOSTED_RUNNER_CANNOT)) expect(keys, key).toContain(key);
	});

	/** the lane still has to be runnable by hand, so the manual names the mechanism and the script */
	it('says in the readme how an exempt lane is run instead', () => {
		for (const [key, needs] of Object.entries(HOSTED_RUNNER_CANNOT)) {
			expect(readme, key).toContain(`${key}=1 bun run test`);
			expect(
				readme.includes(needs),
				`${key}: the readme does not say it needs ${needs}`
			).toBe(true);
		}
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
