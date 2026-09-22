import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import {
	acceptedCves,
	checkPinChange,
	formatFor,
	previousPin,
	resolveV8,
	rolloutPlan,
	sha256Of,
	verifyBinary,
	type Pin
} from '../../../src/update/pin';

const good: Pin = { version: 'v1.20260828.1', sha256: 'a'.repeat(64), storageFormat: 'sqlite-v1' };
const old: Pin = { version: 'v1.20231120.0', sha256: 'b'.repeat(64), storageFormat: 'sqlite-v1' };

describe('verifyBinary', () => {
	it('accepts a binary whose bytes hash to the pin', () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const files = memoryFiles({ '/workerd': bytes });
		const ctx = { ...defaultContext(), files, io: memoryIo(), env: {} };
		expect(() =>
			verifyBinary(ctx, '/workerd', { ...good, sha256: sha256Of(bytes) })
		).not.toThrow();
	});

	it('refuses one that does not, naming both digests', () => {
		const files = memoryFiles({ '/workerd': new Uint8Array([1]) });
		const ctx = { ...defaultContext(), files, io: memoryIo(), env: {} };
		expect(() => verifyBinary(ctx, '/workerd', good)).toThrow(/hashes to/);
	});

	it('refuses a path that is not there', () => {
		const ctx = { ...defaultContext(), files: memoryFiles(), io: memoryIo(), env: {} };
		expect(() => verifyBinary(ctx, '/workerd', good)).toThrow(/not there/);
	});
});

describe('checkPinChange', () => {
	it('accepts a pin above the floor with no format change', () => {
		expect(checkPinChange(good, good)).toEqual({ ok: true, reasons: [] });
	});

	it('refuses a pin below the CVE floor and names the CVE', () => {
		const refusal = checkPinChange(good, old);
		expect(refusal.ok).toBe(false);
		expect(refusal.reasons.join()).toContain('CVE-2023-48230');
	});

	it('accepts it with the force flag, and still says which CVE was accepted', () => {
		expect(checkPinChange(good, old, { forceBelowFloor: true }).ok).toBe(true);
		expect(acceptedCves(old).join()).toContain('CVE-2023-48230');
		expect(acceptedCves(good)).toEqual([]);
	});

	it('refuses a version it cannot parse rather than letting it through', () => {
		const refusal = checkPinChange(good, { ...good, version: 'latest' });
		expect(refusal.ok).toBe(false);
		expect(refusal.reasons.join()).toContain('does not parse');
	});

	it('refuses a change across a storage format without a verified backup', () => {
		const next: Pin = { ...good, storageFormat: 'sqlite-v2' };
		const refusal = checkPinChange(good, next);
		expect(refusal.reasons.join()).toContain('A rollback across that is not a rollback');
	});

	it('accepts it with a verified backup named', () => {
		const next: Pin = { ...good, storageFormat: 'sqlite-v2' };
		expect(
			checkPinChange(good, next, { restoreFrom: '/backups/acme', verifiedBackup: true }).ok
		).toBe(true);
	});

	it('does not accept an unverified backup, which is the whole point of the refusal', () => {
		const next: Pin = { ...good, storageFormat: 'sqlite-v2' };
		expect(
			checkPinChange(good, next, { restoreFrom: '/backups/acme', verifiedBackup: false }).ok
		).toBe(false);
	});

	it('has no format refusal for a first install, where there is nothing to migrate from', () => {
		expect(checkPinChange(null, { ...good, storageFormat: 'sqlite-v9' }).ok).toBe(true);
	});

	it('reports an unknown version s format as unknown rather than guessing', () => {
		expect(formatFor('v1.29990101.0')).toBe('unknown');
		expect(formatFor('1.20260828.1')).toBe('sqlite-v1');
	});
});

describe('rolloutPlan', () => {
	it('makes the first tenant the canary', () => {
		const plan = rolloutPlan(['a', 'b', 'c']);
		expect(plan[0]).toEqual({ tenant: 'a', order: 0, canary: true });
		expect(plan[1]?.canary).toBe(false);
	});

	it('moves a share of the tenants at a percentage', () => {
		expect(rolloutPlan(['a', 'b', 'c', 'd'], 50)).toHaveLength(2);
	});

	it('always moves at least one, so a small percentage is not a no-op', () => {
		expect(rolloutPlan(['a', 'b', 'c'], 1)).toHaveLength(1);
	});

	it('plans nothing for no tenants', () => {
		expect(rolloutPlan([])).toEqual([]);
	});
});

describe('previousPin', () => {
	it('is what a rollback goes back to', () => {
		expect(
			previousPin({
				pins: [
					{ pin: old, appliedAt: 1 },
					{ pin: good, appliedAt: 2 }
				]
			})
		).toBe(old);
	});

	it('is null when there is only one pin, so a rollback refuses rather than reinstalling', () => {
		expect(previousPin({ pins: [{ pin: good, appliedAt: 1 }] })).toBe(null);
	});
});

describe('resolveV8', () => {
	it('reads the version out of workerd s own bazel file', async () => {
		const fetcher = (async () =>
			new Response('VERSION = "15.4.80.5"\n')) as unknown as typeof globalThis.fetch;
		const ctx = { ...defaultContext(), fetch: fetcher, io: memoryIo(), env: {} };
		expect(await resolveV8(ctx, 'v1.20260921.1')).toBe('15.4.80.5');
	});

	it('answers null rather than guessing when the file cannot be read', async () => {
		const fetcher = (async () =>
			new Response('', { status: 404 })) as unknown as typeof globalThis.fetch;
		const ctx = { ...defaultContext(), fetch: fetcher, io: memoryIo(), env: {} };
		expect(await resolveV8(ctx, 'v9')).toBe(null);
	});

	it('answers null when the network is gone rather than raising', async () => {
		const fetcher = (async () =>
			Promise.reject(new Error('offline'))) as unknown as typeof globalThis.fetch;
		const ctx = { ...defaultContext(), fetch: fetcher, io: memoryIo(), env: {} };
		expect(await resolveV8(ctx, 'v9')).toBe(null);
	});
});
