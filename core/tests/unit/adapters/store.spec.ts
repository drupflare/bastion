import { describe, expect, it } from 'vitest';
import { capabilities } from '../../../src/adapters/capabilities';
import { assertCanHonour, isExpired } from '../../../src/adapters/store';

const bytes = new Uint8Array([1, 2, 3]);

describe('a driver refuses rather than drops', () => {
	// an object stored without the metadata its reader expects is indistinguishable from a
	// corrupt one, so silently ignoring an option is worse than failing the write
	it('refuses a conditional write the endpoint cannot do', () => {
		expect(() =>
			assertCanHonour(
				'fs',
				capabilities({ conditionalWrite: false }),
				{ ifAbsent: true },
				bytes
			)
		).toThrow(/cannot write conditionally/);
	});

	it('allows it where the endpoint can', () => {
		expect(() =>
			assertCanHonour(
				'fs',
				capabilities({ conditionalWrite: true }),
				{ ifAbsent: true },
				bytes
			)
		).not.toThrow();
	});

	it('refuses a ttl the endpoint cannot store', () => {
		expect(() =>
			assertCanHonour('fs', capabilities({ ttl: false }), { expiresAt: 10 }, bytes)
		).toThrow(/per-key expiry/);
	});

	it('allows an explicitly null expiry against an endpoint with no ttl', () => {
		expect(() =>
			assertCanHonour('fs', capabilities({ ttl: false }), { expiresAt: null }, bytes)
		).not.toThrow();
	});

	it('refuses a value larger than the endpoint accepts, and names both numbers', () => {
		expect(() =>
			assertCanHonour('kv', capabilities({ maxValueBytes: 2 }), undefined, bytes)
		).toThrow(/3 bytes against its 2 byte limit/);
	});

	it('does not guess a size limit it was never told', () => {
		expect(() =>
			assertCanHonour('kv', capabilities({ maxValueBytes: null }), undefined, bytes)
		).not.toThrow();
	});
});

describe('conservative defaults', () => {
	// an endpoint that could not be probed degrades to more requests, never to failed ones
	it('assumes an unprobed endpoint can do nothing optional', () => {
		const caps = capabilities();
		expect(caps.conditionalWrite).toBe(false);
		expect(caps.byteRange).toBe(false);
		expect(caps.batchDelete).toBe(false);
		expect(caps.ttl).toBe(false);
		expect(caps.maxValueBytes).toBe(null);
	});
});

describe('isExpired', () => {
	it('is false without an expiry', () => {
		expect(isExpired({ bytes, expiresAt: null }, 1000)).toBe(false);
	});

	it('is true at the expiry instant, not only after it', () => {
		expect(isExpired({ bytes, expiresAt: 1000 }, 1000)).toBe(true);
		expect(isExpired({ bytes, expiresAt: 1001 }, 1000)).toBe(false);
	});
});
