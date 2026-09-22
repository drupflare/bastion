import { describe, expect, it } from 'vitest';
import { ConnectionCounter, RateLimiter } from '../../../src/front/ratelimit';

describe('RateLimiter', () => {
	it('allows the burst immediately and refuses the one after it', () => {
		const limiter = new RateLimiter({ rate: 10, burst: 3 });
		expect(limiter.take('a', 0).allowed).toBe(true);
		expect(limiter.take('a', 0).allowed).toBe(true);
		expect(limiter.take('a', 0).allowed).toBe(true);
		expect(limiter.take('a', 0).allowed).toBe(false);
	});

	it('names how long to wait, so the refusal carries a Retry-After', () => {
		const limiter = new RateLimiter({ rate: 10, burst: 1 });
		limiter.take('a', 0);
		expect(limiter.take('a', 0).retryAfterMs).toBe(100);
	});

	it('refills at the configured rate', () => {
		const limiter = new RateLimiter({ rate: 10, burst: 1 });
		expect(limiter.take('a', 0).allowed).toBe(true);
		expect(limiter.take('a', 50).allowed).toBe(false);
		expect(limiter.take('a', 100).allowed).toBe(true);
	});

	it('never refills past the burst', () => {
		const limiter = new RateLimiter({ rate: 10, burst: 2 });
		limiter.take('a', 0);
		expect(limiter.take('a', 1_000_000).allowed).toBe(true);
		expect(limiter.take('a', 1_000_000).allowed).toBe(true);
		expect(limiter.take('a', 1_000_000).allowed).toBe(false);
	});

	it('keys separately, so one client cannot spend another client s budget', () => {
		const limiter = new RateLimiter({ rate: 1, burst: 1 });
		expect(limiter.take('a', 0).allowed).toBe(true);
		expect(limiter.take('b', 0).allowed).toBe(true);
	});

	it('treats a rate of zero as no limit rather than as a total refusal', () => {
		const limiter = new RateLimiter({ rate: 0, burst: 0 });
		expect(limiter.take('a', 0).allowed).toBe(true);
	});

	it('evicts refilled keys so the key space cannot become its own denial of service', () => {
		const limiter = new RateLimiter({ rate: 1000, burst: 1 }, 2);
		limiter.take('a', 0);
		limiter.take('b', 0);
		limiter.take('c', 10_000);
		expect(limiter.size).toBeLessThanOrEqual(2);
	});
});

describe('ConnectionCounter', () => {
	it('refuses past the cap and admits again once one closes', () => {
		const counter = new ConnectionCounter(2);
		expect(counter.open('a')).toBe(true);
		expect(counter.open('a')).toBe(true);
		expect(counter.open('a')).toBe(false);
		counter.close('a');
		expect(counter.open('a')).toBe(true);
	});

	it('forgets a key that has no connections left', () => {
		const counter = new ConnectionCounter(2);
		counter.open('a');
		counter.close('a');
		expect(counter.count('a')).toBe(0);
	});

	it('treats a cap of zero as unlimited', () => {
		const counter = new ConnectionCounter(0);
		for (let i = 0; i < 100; i++) expect(counter.open('a')).toBe(true);
	});
});
