import { describe, expect, it } from 'vitest';
import { generateKey } from '../../../src/tls/csr';
import { assertChain, checkChain, splitChain } from '../../../src/tls/verify';
import { localCa, selfSigned, signLeaf } from '../../../src/tls/x509';

/**
 * A minute ahead of module load, which is what makes this file deterministic.
 *
 * Every certificate below is generated during the run and stamps its own `notBefore` from the
 * real clock, while each assertion checks it as of this constant. DER encodes time to the second,
 * so a bare `Date.now()` here failed whenever generation crossed a second boundary -- about one
 * run in three under load, and never in isolation. The offset dwarfs that and is far smaller than
 * the 5 and 10 day offsets the expiry cases use.
 */
const NOW = Date.now() + 60_000;

describe('splitChain', () => {
	it('finds every certificate in a bundle', () => {
		const ca = localCa('ca');
		expect(splitChain(signLeaf(ca, ['a.test']).certificatePem)).toHaveLength(2);
	});

	it('finds none in something that is not a certificate', () => {
		expect(splitChain('hello')).toEqual([]);
	});
});

describe('checkChain', () => {
	it('accepts a matching leaf and key that covers the host', () => {
		const made = selfSigned(['www.example.edu']);
		const report = checkChain(
			made.certificatePem,
			made.privateKeyPem,
			['www.example.edu'],
			NOW
		);
		expect(report.ok).toBe(true);
		expect(report.hosts).toEqual(['www.example.edu']);
		expect(report.length).toBe(1);
		expect(report.selfSigned).toBe(true);
	});

	it('refuses a key that does not match the leaf, and says what that breaks', () => {
		const made = selfSigned(['www.example.edu']);
		const other = generateKey();
		const report = checkChain(
			made.certificatePem,
			other.privateKeyPem,
			['www.example.edu'],
			NOW
		);
		expect(report.ok).toBe(false);
		expect(report.problems.find((p) => p.id === 'key')?.detail).toContain(
			'fails every handshake'
		);
	});

	it('refuses a certificate that does not cover the host, naming what it does cover', () => {
		const made = selfSigned(['other.example.edu']);
		const report = checkChain(
			made.certificatePem,
			made.privateKeyPem,
			['www.example.edu'],
			NOW
		);
		const problem = report.problems.find((p) => p.id === 'hosts');
		expect(problem?.detail).toContain('www.example.edu');
		expect(problem?.detail).toContain('other.example.edu');
	});

	it('accepts a certificate covering more hosts than the site serves', () => {
		const made = selfSigned(['www.example.edu', 'extra.example.edu']);
		expect(
			checkChain(made.certificatePem, made.privateKeyPem, ['www.example.edu'], NOW).ok
		).toBe(true);
	});

	it('refuses one that has already expired', () => {
		const made = selfSigned(['www.example.edu'], { days: 1, now: NOW - 5 * 86_400_000 });
		const report = checkChain(
			made.certificatePem,
			made.privateKeyPem,
			['www.example.edu'],
			NOW
		);
		expect(report.problems.find((p) => p.id === 'expired')).toBeDefined();
	});

	it('points at the clock when a certificate is not valid yet', () => {
		const made = selfSigned(['www.example.edu'], { now: NOW + 10 * 86_400_000 });
		const report = checkChain(
			made.certificatePem,
			made.privateKeyPem,
			['www.example.edu'],
			NOW
		);
		expect(report.problems.find((p) => p.id === 'not-yet-valid')?.detail).toContain('clock');
	});

	it('accepts a correctly ordered chain', () => {
		const ca = localCa('ca');
		const leaf = signLeaf(ca, ['site.local']);
		const report = checkChain(leaf.certificatePem, leaf.privateKeyPem, ['site.local'], NOW);
		expect(report.ok).toBe(true);
		expect(report.length).toBe(2);
	});

	it('refuses a chain in the wrong order, which is how an institutional chain usually arrives', () => {
		const ca = localCa('ca');
		const leaf = signLeaf(ca, ['site.local']);
		const blocks = splitChain(leaf.certificatePem);
		const reversed = `${blocks[1] as string}\n${blocks[0] as string}\n`;
		const report = checkChain(reversed, null, [], NOW);
		expect(report.problems.find((p) => p.id === 'chain-order')?.detail).toContain(
			'ordered leaf first'
		);
	});

	it('warns without refusing when only the leaf is present', () => {
		const ca = localCa('ca');
		const leafOnly = splitChain(signLeaf(ca, ['site.local']).certificatePem)[0] as string;
		const report = checkChain(leafOnly, null, ['site.local'], NOW);
		expect(report.problems.find((p) => p.id === 'incomplete')?.fatal).toBe(false);
		expect(report.ok).toBe(true);
	});

	it('does not warn about an incomplete chain for a self-signed certificate', () => {
		const made = selfSigned(['a.test']);
		const report = checkChain(made.certificatePem, made.privateKeyPem, ['a.test'], NOW);
		expect(report.problems.find((p) => p.id === 'incomplete')).toBeUndefined();
	});

	it('refuses a file with no certificate in it at all', () => {
		expect(() => checkChain('not a certificate', null, [], NOW)).toThrow(/no PEM certificate/);
	});

	it('refuses a file whose certificate does not parse', () => {
		const broken = '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydA==\n-----END CERTIFICATE-----';
		expect(() => checkChain(broken, null, [], NOW)).toThrow(/did not parse/);
	});

	it('reports the issuer and subject, so an operator can see what they installed', () => {
		const ca = localCa('bastion local CA');
		const leaf = signLeaf(ca, ['site.local']);
		const report = checkChain(leaf.certificatePem, leaf.privateKeyPem, ['site.local'], NOW);
		expect(report.issuer).toContain('bastion local CA');
		expect(report.subject).toContain('site.local');
	});
});

describe('assertChain', () => {
	it('passes a clean report', () => {
		const made = selfSigned(['a.test']);
		const report = checkChain(made.certificatePem, made.privateKeyPem, ['a.test'], NOW);
		expect(() => assertChain(report, 'a.test')).not.toThrow();
	});

	it('names every fatal problem', () => {
		const made = selfSigned(['other.test']);
		const report = checkChain(
			made.certificatePem,
			generateKey().privateKeyPem,
			['a.test'],
			NOW
		);
		try {
			assertChain(report, 'a.test');
			expect.unreachable('should have refused');
		} catch (e) {
			expect((e as Error).message).toContain('key:');
			expect((e as Error).message).toContain('hosts:');
		}
	});
});
