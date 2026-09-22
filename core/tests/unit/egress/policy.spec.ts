import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import {
	applyPolicy,
	checkDrift,
	NEVER_REACHABLE,
	nftablesProgram,
	parseRule,
	rulesFor,
	TABLE,
	wouldAllow
} from '../../../src/egress/policy';
import { scriptedRunner } from '../../../src/host/exec';
import { memoryIo } from '../../../src/io';

const rules = [
	{ host: 'smtp.example.edu', port: 587 },
	{ host: 'updates.drupal.org', port: 443 }
];

function ctx(handlers = {}) {
	const runner = scriptedRunner(handlers);
	return { context: { ...defaultContext(), runner, io: memoryIo(), env: {} }, runner };
}

describe('parseRule', () => {
	it('splits host and port', () => {
		expect(parseRule('smtp.example.edu:587')).toEqual({ host: 'smtp.example.edu', port: 587 });
	});

	it('refuses an entry with no port, rather than assuming 443', () => {
		expect(() => parseRule('smtp.example.edu')).toThrow(/host and a port/);
	});

	it('refuses a port outside the range', () => {
		expect(() => parseRule('a:0')).toThrow(/host:port/);
		expect(() => parseRule('a:70000')).toThrow(/host:port/);
		expect(() => parseRule(':443')).toThrow(/host:port/);
	});

	it('reads a tenant s whole allow list', () => {
		expect(
			rulesFor({ name: 'acme', sites: [], egress: { allow: ['a:1', 'b:2'] } })
		).toHaveLength(2);
	});

	it('gives a tenant with no egress block an empty list, which denies everything', () => {
		expect(rulesFor({ name: 'acme', sites: [] })).toEqual([]);
	});
});

describe('nftablesProgram', () => {
	const program = nftablesProgram('acme', rules);

	it('defaults to drop', () => {
		expect(program).toContain('policy drop');
	});

	it('drops the never-reachable set BEFORE any allow rule', () => {
		const firstAllow = program.indexOf('accept\n\t\tip daddr smtp');
		for (const cidr of NEVER_REACHABLE) {
			const at = program.indexOf(cidr);
			expect(at).toBeGreaterThan(-1);
			if (firstAllow > -1) expect(at).toBeLessThan(firstAllow);
		}
	});

	it('drops metadata, loopback and every private range', () => {
		expect(NEVER_REACHABLE).toContain('169.254.0.0/16');
		expect(NEVER_REACHABLE).toContain('127.0.0.0/8');
		expect(NEVER_REACHABLE).toContain('10.0.0.0/8');
	});

	it('uses ip6 syntax for the v6 ranges', () => {
		expect(program).toContain('ip6 daddr ::1/128 drop');
	});

	it('writes into bastion s own table, never the operator s', () => {
		expect(program).toContain(`table inet ${TABLE}`);
	});

	it('names the chain per tenant, so two tenants never share one', () => {
		expect(nftablesProgram('acme', [])).toContain('chain egress_acme');
		expect(nftablesProgram('lab-1', [])).toContain('chain egress_lab_1');
	});

	it('allows each entry in the list', () => {
		expect(program).toContain('ip daddr smtp.example.edu tcp dport 587 accept');
	});
});

describe('applyPolicy', () => {
	it('feeds the program on stdin rather than through a shell', async () => {
		const { context, runner } = ctx();
		await applyPolicy(context, 'acme', rules);
		expect(runner.calls[0]?.command).toBe('nft');
		expect(runner.calls[0]?.args).toEqual(['-f', '-']);
		expect(runner.calls[0]?.options.input).toContain('policy drop');
	});
});

describe('checkDrift', () => {
	it('reports no drift when the live table matches', async () => {
		const program = nftablesProgram('acme', rules);
		const { context } = ctx({ nft: { code: 0, stdout: program, stderr: '' } });
		expect((await checkDrift(context, 'acme', rules)).drifted).toBe(false);
	});

	it('reports a hand-added rule as extra rather than removing it', async () => {
		const program = `${nftablesProgram('acme', rules)}\n\t\tip daddr 8.8.8.8 tcp dport 53 accept`;
		const { context } = ctx({ nft: { code: 0, stdout: program, stderr: '' } });
		const report = await checkDrift(context, 'acme', rules);
		expect(report.drifted).toBe(true);
		expect(report.extra.join()).toContain('8.8.8.8');
	});

	it('reports a rule that vanished from the live table as missing', async () => {
		const { context } = ctx({ nft: { code: 0, stdout: '', stderr: '' } });
		const report = await checkDrift(context, 'acme', rules);
		expect(report.missing.join()).toContain('smtp.example.edu');
	});
});

describe('wouldAllow', () => {
	it('answers from the policy rather than by opening a socket', () => {
		expect(wouldAllow(rules, 'smtp.example.edu:587').allowed).toBe(true);
		expect(wouldAllow(rules, 'smtp.example.edu:25').allowed).toBe(false);
	});

	it('says WHY a target is denied', () => {
		expect(wouldAllow([], 'a:1').reason).toContain('no egress allow list');
		expect(wouldAllow(rules, 'evil.example:443').reason).toContain('not in the allow list');
	});
});
