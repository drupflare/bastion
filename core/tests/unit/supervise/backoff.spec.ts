import { describe, expect, it } from 'vitest';
import {
	beginTrial,
	DEFAULT_BACKOFF,
	delayFor,
	mayStart,
	newBreaker,
	recordFailure,
	recordSuccess
} from '../../../src/supervise/backoff';

const policy = { ...DEFAULT_BACKOFF, strikes: 3, windowMs: 1000, openMs: 500 };

describe('delayFor', () => {
	it('grows with the attempt', () => {
		const full = () => 1;
		expect(delayFor(1, policy, full)).toBe(policy.baseMs);
		expect(delayFor(2, policy, full)).toBe(policy.baseMs * 2);
		expect(delayFor(3, policy, full)).toBe(policy.baseMs * 4);
	});

	it('never exceeds the ceiling', () => {
		expect(delayFor(50, policy, () => 1)).toBe(policy.maxMs);
	});

	// a rack of tenants restarting in lockstep is its own outage
	it('jitters down to zero, so restarts do not synchronise', () => {
		expect(delayFor(5, policy, () => 0)).toBe(0);
	});

	it('treats attempt zero as the base rather than dividing', () => {
		expect(delayFor(0, policy, () => 1)).toBe(policy.baseMs);
	});
});

describe('the crash-loop breaker', () => {
	it('stays closed below the strike count', () => {
		let breaker = newBreaker();
		breaker = recordFailure(breaker, 0, policy);
		breaker = recordFailure(breaker, 10, policy);
		expect(breaker.state).toBe('closed');
		expect(mayStart(breaker, 20, policy)).toBe(true);
	});

	it('opens at the strike count inside the window', () => {
		let breaker = newBreaker();
		for (const at of [0, 10, 20]) breaker = recordFailure(breaker, at, policy);
		expect(breaker.state).toBe('open');
		expect(mayStart(breaker, 21, policy)).toBe(false);
	});

	// the breaker is about CONSECUTIVE failure, not lifetime failure
	it('forgets failures that fall outside the window', () => {
		let breaker = newBreaker();
		breaker = recordFailure(breaker, 0, policy);
		breaker = recordFailure(breaker, 10, policy);
		breaker = recordFailure(breaker, 2000, policy);
		expect(breaker.state).toBe('closed');
		expect(breaker.failures).toEqual([2000]);
	});

	it('allows a trial start once the open window has passed', () => {
		let breaker = newBreaker();
		for (const at of [0, 10, 20]) breaker = recordFailure(breaker, at, policy);
		expect(mayStart(breaker, 400, policy)).toBe(false);
		expect(mayStart(breaker, 520, policy)).toBe(true);
	});

	it('re-arms the window when a trial begins', () => {
		let breaker = newBreaker();
		for (const at of [0, 10, 20]) breaker = recordFailure(breaker, at, policy);
		breaker = beginTrial(breaker, 600);
		expect(breaker.state).toBe('trial');
		expect(mayStart(breaker, 700, policy)).toBe(false);
	});

	it('clears everything on a clean run', () => {
		let breaker = newBreaker();
		for (const at of [0, 10, 20]) breaker = recordFailure(breaker, at, policy);
		breaker = recordSuccess();
		expect(breaker.state).toBe('closed');
		expect(breaker.failures).toEqual([]);
		expect(mayStart(breaker, 0, policy)).toBe(true);
	});
});
