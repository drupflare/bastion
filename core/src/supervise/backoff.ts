export interface BackoffPolicy {
	/** the first delay, in milliseconds */
	baseMs: number;
	/** the delay never exceeds this */
	maxMs: number;
	/** consecutive failures inside the window before the breaker opens */
	strikes: number;
	/** the window strikes are counted over */
	windowMs: number;
	/** how long the breaker stays open before a single trial restart */
	openMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
	baseMs: 250,
	maxMs: 30_000,
	strikes: 5,
	windowMs: 60_000,
	openMs: 60_000
};

/** exponential with full jitter, so a rack of tenants restarting does not synchronise */
export function delayFor(attempt: number, policy: BackoffPolicy, random = Math.random): number {
	const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
	return Math.floor(random() * ceiling);
}

export type BreakerState = 'closed' | 'open' | 'trial';

export interface Breaker {
	state: BreakerState;
	/** failure timestamps inside the window */
	failures: number[];
	openedAt: number | null;
}

export function newBreaker(): Breaker {
	return { state: 'closed', failures: [], openedAt: null };
}

/**
 * Records a failure and decides whether to keep restarting.
 *
 * A crash loop that restarts forever is indistinguishable from a healthy process to anything
 * watching the process count, and it burns the resource the host is already short of. The breaker
 * opens after `strikes` failures inside `windowMs` and allows one trial restart per `openMs`.
 */
export function recordFailure(breaker: Breaker, now: number, policy: BackoffPolicy): Breaker {
	const failures = [...breaker.failures, now].filter((at) => now - at < policy.windowMs);
	if (failures.length >= policy.strikes) {
		return { state: 'open', failures, openedAt: now };
	}
	return { state: 'closed', failures, openedAt: null };
}

/** a clean start clears the history; the breaker is about consecutive failure, not lifetime */
export function recordSuccess(): Breaker {
	return newBreaker();
}

export function mayStart(breaker: Breaker, now: number, policy: BackoffPolicy): boolean {
	if (breaker.state === 'closed') return true;
	if (breaker.openedAt === null) return true;
	return now - breaker.openedAt >= policy.openMs;
}

/** a trial start after the open window; a failure here re-opens immediately */
export function beginTrial(breaker: Breaker, now: number): Breaker {
	return { ...breaker, state: 'trial', openedAt: now };
}
