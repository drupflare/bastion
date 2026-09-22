export interface RequestSample {
	at: number;
	tenant: string;
	site: string;
	status: number;
	durationMs: number;
	bytes: number;
	/** whether the cache tier answered it, which is the number that explains throughput */
	cached: boolean;
	/** set when the front door refused it, so a refusal is separable from a site error */
	refusal: string | null;
}

export interface Window {
	from: number;
	to: number;
}

export interface SiteAnalytics {
	site: string;
	tenant: string;
	requests: number;
	errors: number;
	refusals: number;
	cachedFraction: number;
	bytes: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
}

function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
	return sorted[index] as number;
}

/**
 * A rolling window of request samples.
 *
 * In memory and bounded, deliberately. Per-request logging is the fastest way to fill a disk on
 * this project's own measured history, so the analytics view reads a ring of recent samples rather
 * than querying a log. What survives a restart is the Prometheus counters, which is where a long
 * time series belongs.
 *
 * The cached fraction is the one number an operator actually needs to explain throughput: the edge
 * tier absorbs most anonymous traffic before the object, so a site that is suddenly slow is almost
 * always a site whose cached fraction fell.
 */
export class AnalyticsWindow {
	private readonly samples: RequestSample[] = [];
	private readonly capacity: number;

	constructor(capacity = 10_000) {
		this.capacity = capacity;
	}

	record(sample: RequestSample): void {
		this.samples.push(sample);
		if (this.samples.length > this.capacity)
			this.samples.splice(0, this.samples.length - this.capacity);
	}

	get size(): number {
		return this.samples.length;
	}

	/** every sample in the window, optionally narrowed to one tenant */
	within(window: Window, tenant?: string): RequestSample[] {
		return this.samples.filter(
			(sample) =>
				sample.at >= window.from &&
				sample.at <= window.to &&
				(tenant === undefined || sample.tenant === tenant)
		);
	}

	summarise(window: Window, tenant?: string): SiteAnalytics[] {
		const bySite = new Map<string, RequestSample[]>();
		for (const sample of this.within(window, tenant)) {
			bySite.set(sample.site, [...(bySite.get(sample.site) ?? []), sample]);
		}
		return [...bySite]
			.map(([site, samples]) => {
				const durations = samples.map((s) => s.durationMs).sort((a, b) => a - b);
				const cached = samples.filter((s) => s.cached).length;
				return {
					site,
					tenant: samples[0]?.tenant ?? '',
					requests: samples.length,
					errors: samples.filter((s) => s.status >= 500).length,
					refusals: samples.filter((s) => s.refusal !== null).length,
					cachedFraction: samples.length === 0 ? 0 : cached / samples.length,
					bytes: samples.reduce((n, s) => n + s.bytes, 0),
					p50Ms: percentile(durations, 0.5),
					p95Ms: percentile(durations, 0.95),
					p99Ms: percentile(durations, 0.99)
				};
			})
			.sort((a, b) => b.requests - a.requests);
	}

	/** the status codes seen, so a spike in one is visible without reading every line */
	statuses(window: Window, tenant?: string): Record<string, number> {
		const out: Record<string, number> = {};
		for (const sample of this.within(window, tenant)) {
			const bucket = `${Math.floor(sample.status / 100)}xx`;
			out[bucket] = (out[bucket] ?? 0) + 1;
		}
		return out;
	}

	/** requests per bucket, for a sparkline that does not need a time series database */
	series(window: Window, buckets = 24, tenant?: string): { at: number; requests: number }[] {
		const span = Math.max(1, window.to - window.from);
		const width = span / buckets;
		const out = Array.from({ length: buckets }, (_, index) => ({
			at: Math.round(window.from + index * width),
			requests: 0
		}));
		for (const sample of this.within(window, tenant)) {
			const index = Math.min(buckets - 1, Math.floor((sample.at - window.from) / width));
			const bucket = out[index];
			if (bucket !== undefined) bucket.requests += 1;
		}
		return out;
	}
}

/**
 * What a tenant may see against what an operator may see.
 *
 * A tenant's view is its own sites and nothing else, and it carries no host figures at all: CPU,
 * memory and disk belong to the box, and showing one tenant the box's load tells them about every
 * other tenant on it.
 */
export function scopeFor(role: 'operator' | 'tenant-admin' | 'tenant-viewer'): {
	tenantOnly: boolean;
	hostMetrics: boolean;
} {
	return role === 'operator'
		? { tenantOnly: false, hostMetrics: true }
		: { tenantOnly: true, hostMetrics: false };
}

/**
 * One Analytics Engine data point, as a Worker writes it.
 *
 * Cloudflare's own binding is `analyticsEngine @17 :ServiceDesignator` and is gated behind
 * `--experimental`, which bastion does not pass: the same flag unlocks unsafe-eval, the worker
 * loader and the debug port, and taking three of those to get one is not a trade worth making.
 * So the binding is a wrapped module over this instead.
 */
export interface DataPoint {
	indexes: string[];
	doubles: number[];
	blobs: string[];
	at: number;
	tenant: string;
	site: string | null;
}

/** what a data point may carry; a write past one is truncated rather than refused */
export const DATA_POINT_LIMITS = { indexes: 1, doubles: 20, blobs: 20, indexBytes: 96 } as const;

/**
 * A bounded ring of data points per tenant.
 *
 * Bounded because this is the exact shape that already cost this project a disk: miniflare's
 * observability wrote every request into one unpruned file and reached 20.75 GB. A tenant looping
 * on `writeDataPoint` fills a ring and evicts its own oldest rows rather than the host's free
 * space.
 */
export class DataPointWindow {
	private readonly points: DataPoint[] = [];
	private readonly capacity: number;

	constructor(capacity = 10_000) {
		this.capacity = capacity;
	}

	write(point: DataPoint): void {
		// truncate rather than refuse: Cloudflare's own binding returns void, so a caller has
		// nowhere to see a rejection and would simply lose the write with no signal either way
		this.points.push({
			...point,
			indexes: point.indexes
				.slice(0, DATA_POINT_LIMITS.indexes)
				.map((value) => value.slice(0, DATA_POINT_LIMITS.indexBytes)),
			doubles: point.doubles.slice(0, DATA_POINT_LIMITS.doubles),
			blobs: point.blobs.slice(0, DATA_POINT_LIMITS.blobs)
		});
		if (this.points.length > this.capacity) {
			this.points.splice(0, this.points.length - this.capacity);
		}
	}

	/** every point, newest last, optionally narrowed to one tenant */
	all(tenant?: string): DataPoint[] {
		return tenant === undefined
			? [...this.points]
			: this.points.filter((point) => point.tenant === tenant);
	}

	get size(): number {
		return this.points.length;
	}
}
