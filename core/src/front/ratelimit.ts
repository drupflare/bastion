export interface Bucket {
	tokens: number;
	updatedAt: number;
}

export interface LimitPolicy {
	/** sustained requests per second */
	rate: number;
	/** how many may arrive at once before the rate binds */
	burst: number;
}

/**
 * A token bucket per key.
 *
 * Per IP and per tenant, because they answer different questions: the first bounds one abusive
 * client, the second bounds one tenant's share of a box every other tenant is also on. There is
 * no WAF and no DDoS absorption in front of a self-hosted box, so a POST flood against one tenant
 * is an outage for every tenant on it unless this binds.
 */
export class RateLimiter {
	private readonly buckets = new Map<string, Bucket>();
	private readonly policy: LimitPolicy;
	/** evicted lazily; an unbounded key space is its own denial of service */
	private readonly maxKeys: number;

	constructor(policy: LimitPolicy, maxKeys = 100_000) {
		this.policy = policy;
		this.maxKeys = maxKeys;
	}

	get size(): number {
		return this.buckets.size;
	}

	/** whether the request may proceed, and how long to wait when it may not */
	take(key: string, now: number, cost = 1): { allowed: boolean; retryAfterMs: number } {
		if (this.policy.rate <= 0) return { allowed: true, retryAfterMs: 0 };
		const bucket = this.buckets.get(key) ?? { tokens: this.policy.burst, updatedAt: now };
		const elapsed = Math.max(0, now - bucket.updatedAt);
		const refilled = Math.min(
			this.policy.burst,
			bucket.tokens + (elapsed * this.policy.rate) / 1000
		);
		if (refilled < cost) {
			this.buckets.set(key, { tokens: refilled, updatedAt: now });
			const deficit = cost - refilled;
			return { allowed: false, retryAfterMs: Math.ceil((deficit / this.policy.rate) * 1000) };
		}
		if (this.buckets.size >= this.maxKeys && !this.buckets.has(key)) this.evict(now);
		this.buckets.set(key, { tokens: refilled - cost, updatedAt: now });
		return { allowed: true, retryAfterMs: 0 };
	}

	/** drops keys that have refilled to full, which are the ones holding no state worth keeping */
	private evict(now: number): void {
		const fullAfterMs = (this.policy.burst / this.policy.rate) * 1000;
		for (const [key, bucket] of this.buckets) {
			if (now - bucket.updatedAt >= fullAfterMs) this.buckets.delete(key);
		}
	}
}

/**
 * Concurrent connections per address.
 *
 * Separate from the rate limiter because slowloris does not spend tokens: it opens connections and
 * sends almost nothing, so a request-rate limit never sees it.
 */
export class ConnectionCounter {
	private readonly counts = new Map<string, number>();
	private readonly max: number;

	constructor(max: number) {
		this.max = max;
	}

	open(key: string): boolean {
		const current = this.counts.get(key) ?? 0;
		if (this.max > 0 && current >= this.max) return false;
		this.counts.set(key, current + 1);
		return true;
	}

	close(key: string): void {
		const current = this.counts.get(key) ?? 0;
		if (current <= 1) this.counts.delete(key);
		else this.counts.set(key, current - 1);
	}

	count(key: string): number {
		return this.counts.get(key) ?? 0;
	}
}
