import { describe, expect, it } from 'vitest';
import { VERSION_FLOORS } from '../../../src/config/defaults';
import {
	checkFloor,
	compareSemver,
	compareWorkerd,
	parseWorkerdVersion,
	requireFloor
} from '../../../src/workerd/version';

describe('workerd versions', () => {
	it('parses a tag with or without the v', () => {
		expect(parseWorkerdVersion('v1.20260828.1')).toEqual([1, 20260828, 1]);
		expect(parseWorkerdVersion('1.20260828.1')).toEqual([1, 20260828, 1]);
	});

	it('refuses anything that is not a workerd tag', () => {
		expect(parseWorkerdVersion('1.2.3')).toBe(null);
		expect(parseWorkerdVersion('latest')).toBe(null);
	});

	it('orders by date then patch', () => {
		expect(compareWorkerd('v1.20260828.1', 'v1.20260827.1')).toBe(1);
		expect(compareWorkerd('v1.20260828.1', 'v1.20260828.2')).toBe(-1);
		expect(compareWorkerd('v1.20260828.1', 'v1.20260828.1')).toBe(0);
	});

	it('orders semver for firecracker', () => {
		expect(compareSemver('1.15.1', '1.14.4')).toBe(1);
		expect(compareSemver('1.9.0', '1.10.0')).toBe(-1);
	});
});

describe('floors', () => {
	it('clears a version at or above the floor', () => {
		expect(checkFloor('workerd', 'v1.20260828.1', VERSION_FLOORS.workerd).ok).toBe(true);
		expect(checkFloor('workerd', VERSION_FLOORS.workerd, VERSION_FLOORS.workerd).ok).toBe(true);
	});

	// a refusal that does not say what it is protecting is a number, not a reason
	it('names the CVE when a version is below the floor', () => {
		const verdict = checkFloor('workerd', 'v1.20230419.0', VERSION_FLOORS.workerd);
		expect(verdict.ok).toBe(false);
		expect(verdict.message).toContain('CVE-2023-48230');
	});

	it('names the firecracker CVE too', () => {
		const verdict = checkFloor('firecracker', '1.14.0', VERSION_FLOORS.firecracker);
		expect(verdict.ok).toBe(false);
		expect(verdict.message).toContain('CVE-2026-5747');
	});

	it('refuses to guess when a version cannot be compared', () => {
		expect(checkFloor('workerd', 'nightly', VERSION_FLOORS.workerd).ok).toBe(false);
	});

	it('raises below the floor, and names the next command', () => {
		try {
			requireFloor('workerd', 'v1.20230419.0', VERSION_FLOORS.workerd);
			expect.unreachable('should have raised');
		} catch (e) {
			expect((e as { code: string }).code).toBe('below-floor');
			expect((e as { next: string }).next).toContain(VERSION_FLOORS.workerd);
		}
	});

	it('accepts below the floor only when explicitly forced', () => {
		expect(requireFloor('workerd', 'v1.20230419.0', VERSION_FLOORS.workerd, true).ok).toBe(
			false
		);
	});
});
