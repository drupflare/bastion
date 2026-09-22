import { describe, expect, it } from 'vitest';
import { DEFAULT_RESTART, dueForRestart, nextRestart } from '../../../src/isolation/restart';

describe('nextRestart', () => {
	it('is a day out by default, which is the interval Cloudflare states for its own runtime', () => {
		expect(DEFAULT_RESTART.everyMs).toBe(24 * 60 * 60 * 1000);
	});

	it('spreads tenants across the jitter window rather than restarting them together', () => {
		const a = nextRestart('acme', 0);
		const b = nextRestart('labs', 0);
		expect(a).not.toBe(b);
	});

	it('derives the slot from the name, so a restarted bastion keeps it', () => {
		expect(nextRestart('acme', 0)).toBe(nextRestart('acme', 0));
	});

	it('never lands before the interval', () => {
		const at = nextRestart('acme', 1000) as number;
		expect(at).toBeGreaterThanOrEqual(1000 + DEFAULT_RESTART.everyMs);
		expect(at).toBeLessThan(1000 + DEFAULT_RESTART.everyMs + DEFAULT_RESTART.jitterMs);
	});

	it('is off when the interval is zero', () => {
		expect(nextRestart('acme', 0, { everyMs: 0, jitterMs: 0 })).toBe(null);
		expect(dueForRestart('acme', 0, 1e12, { everyMs: 0, jitterMs: 0 })).toBe(false);
	});

	it('has no jitter when the window is zero', () => {
		expect(nextRestart('acme', 0, { everyMs: 100, jitterMs: 0 })).toBe(100);
	});
});

describe('dueForRestart', () => {
	it('is false before the interval and true after it', () => {
		const policy = { everyMs: 100, jitterMs: 0 };
		expect(dueForRestart('acme', 0, 99, policy)).toBe(false);
		expect(dueForRestart('acme', 0, 100, policy)).toBe(true);
	});
});
