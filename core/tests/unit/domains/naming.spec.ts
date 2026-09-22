import { describe, expect, it } from 'vitest';
import {
	allocate,
	apexOf,
	checkLabel,
	isUnderPrimary,
	RESERVED_LABELS,
	suggest
} from '../../../src/domains/naming';

const primary = { domain: 'sites.example.edu' };

describe('checkLabel', () => {
	it('accepts an ordinary label and builds the host', () => {
		expect(checkLabel('alice', primary)).toEqual({ ok: true, host: 'alice.sites.example.edu' });
	});

	it('normalises case and a trailing dot, because DNS does', () => {
		expect(checkLabel('Alice.', primary)).toEqual({
			ok: true,
			host: 'alice.sites.example.edu'
		});
	});

	it('refuses an empty or over-long label', () => {
		expect(checkLabel('  ', primary).ok).toBe(false);
		expect(checkLabel('a'.repeat(64), primary).ok).toBe(false);
		expect(checkLabel('a'.repeat(63), primary).ok).toBe(true);
	});

	it('refuses a label that is not valid DNS', () => {
		for (const bad of ['-alice', 'alice-', 'al ice', 'al_ice', 'aliç', 'a.b']) {
			expect(checkLabel(bad, primary).ok, bad).toBe(false);
		}
	});

	it('refuses a reserved label, so one student cannot take www', () => {
		for (const reserved of ['www', 'admin', 'api', 'dashboard']) {
			expect(checkLabel(reserved, primary).ok).toBe(false);
			expect(RESERVED_LABELS.has(reserved)).toBe(true);
		}
	});

	it('refuses a label the operator additionally reserved', () => {
		expect(checkLabel('registrar', { ...primary, reserved: ['registrar'] }).ok).toBe(false);
	});

	it('refuses a name already taken, comparing the way DNS does', () => {
		const taken = ['Alice.Sites.Example.EDU.'];
		expect(checkLabel('alice', primary, taken)).toMatchObject({ ok: false });
		expect((checkLabel('alice', primary, taken) as { reason: string }).reason).toContain(
			'taken'
		);
	});

	it('never refuses the ACME or the bastion challenge name as a site', () => {
		expect(checkLabel('_acme-challenge', primary).ok).toBe(false);
		expect(checkLabel('_bastion-challenge', primary).ok).toBe(false);
	});
});

describe('allocate', () => {
	it('returns the host', () => {
		expect(allocate('alice', primary)).toBe('alice.sites.example.edu');
	});

	it('raises with the reason and a next command', () => {
		try {
			allocate('www', primary);
			expect.unreachable('should have refused');
		} catch (e) {
			expect((e as Error).message).toContain('reserved');
			expect((e as { next: string }).next).toBe('bastion domain list');
		}
	});
});

describe('suggest', () => {
	it('returns the preferred name when it is free', () => {
		expect(suggest('alice', primary)).toBe('alice.sites.example.edu');
	});

	it('appends a number a human can read out loud rather than a random suffix', () => {
		expect(suggest('alice', primary, ['alice.sites.example.edu'])).toBe(
			'alice-2.sites.example.edu'
		);
	});

	it('cleans a name that is not valid DNS rather than refusing outright', () => {
		expect(suggest('Alice Smith!', primary)).toBe('alice-smith.sites.example.edu');
	});

	it('skips past a run of taken names', () => {
		const taken = ['alice.sites.example.edu', 'alice-2.sites.example.edu'];
		expect(suggest('alice', primary, taken)).toBe('alice-3.sites.example.edu');
	});
});

describe('isUnderPrimary', () => {
	it('is true for one label under the primary domain', () => {
		expect(isUnderPrimary('alice.sites.example.edu', primary)).toBe(true);
	});

	it('is false for a deeper name, which is a different delegation', () => {
		expect(isUnderPrimary('a.b.sites.example.edu', primary)).toBe(false);
	});

	it('is false for the primary domain itself and for anything outside it', () => {
		expect(isUnderPrimary('sites.example.edu', primary)).toBe(false);
		expect(isUnderPrimary('www.example.edu', primary)).toBe(false);
		expect(isUnderPrimary('evilsites.example.edu', primary)).toBe(false);
	});
});

describe('apexOf', () => {
	it('names the apex a www record belongs to', () => {
		expect(apexOf('www.example.edu')).toBe('example.edu');
	});

	it('is null for anything that is not a www name', () => {
		expect(apexOf('example.edu')).toBe(null);
		expect(apexOf('alice.sites.example.edu')).toBe(null);
	});
});
