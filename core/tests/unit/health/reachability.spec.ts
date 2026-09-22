import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/defaults';
import { checkTripwires, configKeys, unreadConfigKeys } from '../../../src/health/reachability';
import { BY_CODE, TRIPWIRES } from '../../../src/health/tripwires';

describe('checkTripwires', () => {
	it('passes on the shipped table', () => {
		expect(checkTripwires()).toEqual([]);
	});

	it('gives every tripwire either an automatic repair or a button', () => {
		for (const tripwire of TRIPWIRES) {
			expect(tripwire.repair !== null || tripwire.button !== '').toBe(true);
		}
	});

	it('gives every tripwire an explanation diagnose can print', () => {
		for (const tripwire of TRIPWIRES) expect(tripwire.means.length).toBeGreaterThan(10);
	});

	it('makes every button a command rather than advice', () => {
		for (const tripwire of TRIPWIRES) expect(tripwire.button.startsWith('bastion ')).toBe(true);
	});

	it('has no duplicate codes', () => {
		expect(Object.keys(BY_CODE)).toHaveLength(TRIPWIRES.length);
	});

	it('marks the four unrecoverable ones critical', () => {
		for (const code of [
			'adapter.partial_read',
			'audit.chain_broken',
			'backup.verify_failed',
			'isolation.mode_downgraded'
		]) {
			expect(BY_CODE[code]?.severity).toBe('critical');
		}
	});

	it('never automates a repair for the codes where only an operator should act', () => {
		for (const code of [
			'audit.chain_broken',
			'adapter.partial_read',
			'isolation.mode_downgraded'
		]) {
			expect(BY_CODE[code]?.repair).toBe(null);
		}
	});
});

describe('configKeys', () => {
	it('walks every dotted path a caller can set', () => {
		const keys = configKeys(defaultConfig());
		expect(keys).toContain('front.rateLimit.perIp');
		expect(keys).toContain('runtime.limits.isolateMemory');
	});

	it('does not descend into an array, which has indices rather than keys', () => {
		expect(configKeys({ a: [{ b: 1 }] })).toEqual(['a']);
	});
});

describe('unreadConfigKeys', () => {
	it('reports a key nothing reads', () => {
		expect(unreadConfigKeys(['front.decorative'], ['const x = 1;'])).toEqual(['decorative']);
	});

	it('accepts a key something reads', () => {
		expect(unreadConfigKeys(['front.maxBodyBytes'], ['config.front.maxBodyBytes'])).toEqual([]);
	});

	it('does not match a key that is only a substring of another word', () => {
		expect(unreadConfigKeys(['front.http2'], ['const http2x = 1;'])).toEqual(['http2']);
	});

	it('honours an exemption', () => {
		expect(unreadConfigKeys(['front.decorative'], [''], ['decorative'])).toEqual([]);
	});
});
