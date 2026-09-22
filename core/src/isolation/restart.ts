export interface RestartPolicy {
	/** milliseconds between scheduled restarts; 0 turns it off */
	everyMs: number;
	/** spread across this window so every tenant does not restart at once */
	jitterMs: number;
}

/**
 * A daily restart of every tenant's runtime.
 *
 * One of the few Cloudflare mitigations a single box can actually reproduce: they restart the
 * Workers runtime on a daily basis to re-randomise memory layout, and say so plainly. It costs a
 * cold start per tenant and buys a bounded lifetime for any memory-disclosure primitive that
 * depends on layout.
 *
 * The jitter matters as much as the interval. Restarting every tenant on the same tick is a
 * self-inflicted thundering herd at the cache and the disk, which on a box with forty tenants is
 * an outage rather than a maintenance window.
 */
export const DEFAULT_RESTART: RestartPolicy = {
	everyMs: 24 * 60 * 60 * 1000,
	jitterMs: 60 * 60 * 1000
};

export function nextRestart(
	tenant: string,
	startedAt: number,
	policy: RestartPolicy = DEFAULT_RESTART
): number | null {
	if (policy.everyMs <= 0) return null;
	// derived from the name rather than random, so a restarted bastion keeps each tenant's slot
	let hash = 0x811c9dc5;
	for (const char of tenant) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const offset = policy.jitterMs === 0 ? 0 : hash % policy.jitterMs;
	return startedAt + policy.everyMs + offset;
}

export function dueForRestart(
	tenant: string,
	startedAt: number,
	now: number,
	policy: RestartPolicy = DEFAULT_RESTART
): boolean {
	const due = nextRestart(tenant, startedAt, policy);
	return due !== null && now >= due;
}
