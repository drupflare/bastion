import { describe, expect, it } from 'vitest';
import { fixtureResolver, isAbsent } from '../../../src/domains/dns';
import {
	assertReady,
	challengeName,
	challengeToken,
	checkDomain
} from '../../../src/domains/verify';

const SECRET = 'install-secret';
const HOST = 'www.example.edu';
const token = challengeToken(SECRET, 'acme', HOST);

function resolver(over: Record<string, Record<string, unknown[]>> = {}) {
	return fixtureResolver({
		txt: { [challengeName(HOST)]: [token] },
		a: { [HOST]: ['203.0.113.10'] },
		aaaa: {},
		cname: {},
		caa: {},
		...over
	} as never);
}

const options = { addresses: ['203.0.113.10'], caaIdentity: 'letsencrypt.org' };

describe('challengeToken', () => {
	it('is stable, so an operator can print it again without invalidating what they published', () => {
		expect(challengeToken(SECRET, 'acme', HOST)).toBe(challengeToken(SECRET, 'acme', HOST));
	});

	it('differs per tenant, so one tenant cannot pre-publish another tenant s proof', () => {
		expect(challengeToken(SECRET, 'acme', HOST)).not.toBe(challengeToken(SECRET, 'labs', HOST));
	});

	it('ignores case in the host, because DNS does', () => {
		expect(challengeToken(SECRET, 'acme', 'WWW.Example.EDU')).toBe(token);
	});

	it('is published under a name that cannot collide with the ACME challenge', () => {
		expect(challengeName(HOST)).toBe('_bastion-challenge.www.example.edu');
		expect(challengeName(HOST)).not.toContain('_acme-challenge');
	});
});

describe('checkDomain', () => {
	it('passes every check for a correctly configured domain', async () => {
		const report = await checkDomain(resolver(), SECRET, 'acme', HOST, options);
		expect(report.ready).toBe(true);
		expect(report.checks.map((c) => c.id).sort()).toEqual(['caa', 'dns', 'ownership']);
	});

	it('names the exact TXT record to publish when ownership is unproved', async () => {
		const report = await checkDomain(resolver({ txt: {} }), SECRET, 'acme', HOST, options);
		expect(report.ready).toBe(false);
		expect(report.instructions).toContain(`TXT ${challengeName(HOST)} "${token}"`);
	});

	it('refuses a token that belongs to a different tenant', async () => {
		const other = challengeToken(SECRET, 'labs', HOST);
		const report = await checkDomain(
			fixtureResolver({
				txt: { [challengeName(HOST)]: [other] },
				a: { [HOST]: ['203.0.113.10'] }
			} as never),
			SECRET,
			'acme',
			HOST,
			options
		);
		expect(report.checks.find((c) => c.id === 'ownership')?.state).toBe('fail');
	});

	it('names the A record to publish when the domain resolves to nothing', async () => {
		const report = await checkDomain(
			fixtureResolver({ txt: { [challengeName(HOST)]: [token] } } as never),
			SECRET,
			'acme',
			HOST,
			options
		);
		expect(report.instructions).toContain(`A ${HOST} 203.0.113.10`);
	});

	it('says where a domain points when it points somewhere else', async () => {
		const report = await checkDomain(
			fixtureResolver({
				txt: { [challengeName(HOST)]: [token] },
				a: { [HOST]: ['198.51.100.1'] }
			} as never),
			SECRET,
			'acme',
			HOST,
			options
		);
		const dns = report.checks.find((c) => c.id === 'dns');
		expect(dns?.state).toBe('fail');
		expect(dns?.detail).toContain('198.51.100.1');
		expect(dns?.detail).toContain('203.0.113.10');
	});

	it('treats a CNAME as unknown rather than wrong, because it may still reach here', async () => {
		const report = await checkDomain(
			fixtureResolver({
				txt: { [challengeName(HOST)]: [token] },
				cname: { [HOST]: ['node.example.edu'] }
			} as never),
			SECRET,
			'acme',
			HOST,
			options
		);
		expect(report.checks.find((c) => c.id === 'dns')?.state).toBe('unknown');
	});

	it('catches a CAA that would make the CA refuse, which is the most opaque failure here', async () => {
		const report = await checkDomain(
			fixtureResolver({
				txt: { [challengeName(HOST)]: [token] },
				a: { [HOST]: ['203.0.113.10'] },
				caa: { [HOST]: [{ critical: 0, tag: 'issue', value: 'digicert.com' }] }
			} as never),
			SECRET,
			'acme',
			HOST,
			options
		);
		const caa = report.checks.find((c) => c.id === 'caa');
		expect(caa?.state).toBe('fail');
		expect(caa?.detail).toContain('digicert.com');
		expect(report.instructions).toContain(`CAA ${HOST} 0 issue "letsencrypt.org"`);
	});

	it('accepts a CAA that does name the configured CA, with parameters after it', async () => {
		const report = await checkDomain(
			fixtureResolver({
				txt: { [challengeName(HOST)]: [token] },
				a: { [HOST]: ['203.0.113.10'] },
				caa: {
					[HOST]: [
						{
							critical: 0,
							tag: 'issue',
							value: 'letsencrypt.org; validationmethods=dns-01'
						}
					]
				}
			} as never),
			SECRET,
			'acme',
			HOST,
			options
		);
		expect(report.checks.find((c) => c.id === 'caa')?.state).toBe('pass');
	});

	it('treats no CAA record as permission, which is what the specification says', async () => {
		const report = await checkDomain(resolver(), SECRET, 'acme', HOST, options);
		expect(report.checks.find((c) => c.id === 'caa')?.detail).toContain('any CA may issue');
	});

	it('skips ownership for a name bastion already controls', async () => {
		const report = await checkDomain(resolver({ txt: {} }), SECRET, 'acme', HOST, {
			...options,
			requireOwnership: false
		});
		expect(report.checks.map((c) => c.id)).not.toContain('ownership');
		expect(report.ready).toBe(true);
	});

	it('answers unknown rather than pass when this node has no configured address', async () => {
		const report = await checkDomain(resolver(), SECRET, 'acme', HOST, { addresses: [] });
		expect(report.checks.find((c) => c.id === 'dns')?.state).toBe('unknown');
		expect(report.ready).toBe(false);
	});
});

describe('assertReady', () => {
	it('passes a ready report', async () => {
		expect(() =>
			assertReady({ host: HOST, tenant: 'acme', ready: true, checks: [], instructions: [] })
		).not.toThrow();
	});

	it('names every failed check and the records to publish', async () => {
		const report = await checkDomain(resolver({ txt: {} }), SECRET, 'acme', HOST, options);
		try {
			assertReady(report);
			expect.unreachable('should have refused');
		} catch (e) {
			expect((e as Error).message).toContain('ownership');
			expect((e as Error).message).toContain('publish these records');
			expect((e as { next: string }).next).toContain('bastion domain verify');
		}
	});
});

describe('isAbsent', () => {
	it('treats an absent record as an answer rather than a resolver failure', () => {
		expect(isAbsent({ code: 'ENODATA' })).toBe(true);
		expect(isAbsent({ code: 'ENOTFOUND' })).toBe(true);
		expect(isAbsent({ code: 'ESERVFAIL' })).toBe(false);
	});
});
