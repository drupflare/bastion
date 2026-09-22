import { describe, expect, it } from 'vitest';
import { AnalyticsWindow, scopeFor, type RequestSample } from '../../../src/observe/analytics';

function sample(over: Partial<RequestSample> = {}): RequestSample {
	return {
		at: 1000,
		tenant: 'acme',
		site: 'www.example.edu',
		status: 200,
		durationMs: 10,
		bytes: 100,
		cached: true,
		refusal: null,
		...over
	};
}

const window = { from: 0, to: 10_000 };

describe('AnalyticsWindow', () => {
	it('summarises requests, errors and refusals separately', () => {
		const w = new AnalyticsWindow();
		w.record(sample());
		w.record(sample({ status: 500 }));
		w.record(sample({ status: 429, refusal: 'rate-limit-ip' }));
		const [summary] = w.summarise(window);
		expect(summary?.requests).toBe(3);
		expect(summary?.errors).toBe(1);
		expect(summary?.refusals).toBe(1);
	});

	it('reports the cached fraction, which is the number that explains throughput', () => {
		const w = new AnalyticsWindow();
		w.record(sample({ cached: true }));
		w.record(sample({ cached: true }));
		w.record(sample({ cached: false }));
		expect(w.summarise(window)[0]?.cachedFraction).toBeCloseTo(2 / 3);
	});

	it('reports percentiles rather than an average, which one slow request would hide', () => {
		const w = new AnalyticsWindow();
		for (let i = 1; i <= 100; i++) w.record(sample({ durationMs: i }));
		const [summary] = w.summarise(window);
		expect(summary?.p50Ms).toBeGreaterThan(40);
		expect(summary?.p50Ms).toBeLessThan(60);
		expect(summary?.p99Ms).toBeGreaterThan(summary?.p95Ms as number);
	});

	it('groups per site and orders by traffic', () => {
		const w = new AnalyticsWindow();
		w.record(sample({ site: 'quiet.example.edu' }));
		for (let i = 0; i < 5; i++) w.record(sample({ site: 'busy.example.edu' }));
		expect(w.summarise(window).map((s) => s.site)).toEqual([
			'busy.example.edu',
			'quiet.example.edu'
		]);
	});

	it('narrows to one tenant, which is what a tenant view reads', () => {
		const w = new AnalyticsWindow();
		w.record(sample({ tenant: 'acme', site: 'a.edu' }));
		w.record(sample({ tenant: 'labs', site: 'b.edu' }));
		expect(w.summarise(window, 'acme').map((s) => s.site)).toEqual(['a.edu']);
	});

	it('excludes anything outside the window', () => {
		const w = new AnalyticsWindow();
		w.record(sample({ at: 50_000 }));
		expect(w.summarise(window)).toEqual([]);
	});

	it('is bounded, because per-request history is what fills a disk', () => {
		const w = new AnalyticsWindow(10);
		for (let i = 0; i < 100; i++) w.record(sample());
		expect(w.size).toBe(10);
	});

	it('buckets status codes so a spike is visible without reading every line', () => {
		const w = new AnalyticsWindow();
		w.record(sample({ status: 200 }));
		w.record(sample({ status: 404 }));
		w.record(sample({ status: 500 }));
		expect(w.statuses(window)).toEqual({ '2xx': 1, '4xx': 1, '5xx': 1 });
	});

	it('builds a series with a fixed number of buckets', () => {
		const w = new AnalyticsWindow();
		w.record(sample({ at: 100 }));
		w.record(sample({ at: 9900 }));
		const series = w.series(window, 10);
		expect(series).toHaveLength(10);
		expect(series[0]?.requests).toBe(1);
		expect(series[9]?.requests).toBe(1);
	});

	it('answers an empty summary rather than raising with no samples', () => {
		expect(new AnalyticsWindow().summarise(window)).toEqual([]);
		expect(new AnalyticsWindow().statuses(window)).toEqual({});
	});
});

describe('scopeFor', () => {
	it('gives an operator the host figures and a tenant none', () => {
		expect(scopeFor('operator')).toEqual({ tenantOnly: false, hostMetrics: true });
		expect(scopeFor('tenant-admin')).toEqual({ tenantOnly: true, hostMetrics: false });
		expect(scopeFor('tenant-viewer')).toEqual({ tenantOnly: true, hostMetrics: false });
	});
});
