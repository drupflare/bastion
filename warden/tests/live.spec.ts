import {
	defaultConfig,
	memoryFiles,
	memoryIo,
	recordingListenerHost,
	Runtime,
	scriptedRunner,
	type ApiHandler,
	type Context
} from '@drupflare/bastion';
import { describe, expect, it } from 'vitest';
import { liveHandlers } from '../src/api/live';

/**
 * The one route whose answer is not a command.
 *
 * The analytics window is an in-memory ring of served requests held by the `serve` process, so a
 * second process running a CLI command has nothing to read. Routing it through the CLI like every
 * other route is what made `/api/metrics` answer Prometheus text to a page that reads rows off it.
 */
function harness() {
	const ctx: Context = {
		io: memoryIo(),
		files: memoryFiles({}),
		runner: scriptedRunner(),
		fetch: () => Promise.reject(new Error('no network')),
		env: {},
		cwd: '/srv',
		platform: 'linux',
		now: () => 10_000
	};
	const runtime = new Runtime(ctx, {
		config: defaultConfig(),
		host: recordingListenerHost(),
		upstream: () => Promise.resolve(new Response('ok')),
		platform: 'linux'
	});
	for (const sample of [
		{ site: 'www.example.edu', tenant: 'acme', status: 200, cached: true },
		{ site: 'www.example.edu', tenant: 'acme', status: 500, cached: false },
		{ site: 'docs.example.edu', tenant: 'beta', status: 200, cached: false }
	]) {
		runtime.analytics.record({
			at: 5_000,
			durationMs: 12,
			bytes: 100,
			refusal: null,
			...sample
		});
	}
	runtime.unattributed.set('rate-limited', 4);

	const text: ApiHandler = () => 'bastion_tenant_sites 1';
	const handlers = liveHandlers(runtime, { 'GET /api/metrics': text });
	const ask = (accept: string, tenant: string | null = null) =>
		handlers['GET /api/metrics']?.({
			ctx,
			principal: { id: 'op', role: 'operator', tenant, credential: 'session' },
			tenant,
			params: {},
			request: new Request('https://127.0.0.1:8787/api/metrics?from=0&to=10000', {
				headers: { accept }
			})
		});
	return { ask, runtime };
}

interface Analytics {
	sites: { site: string; requests: number; errors: number }[];
	statuses: Record<string, number>;
	series: unknown[];
	unattributed: Record<string, number>;
}

describe('GET /api/metrics', () => {
	it('answers a scrape with the exposition format, which is still the command', async () => {
		const answer = await harness().ask('text/plain');
		expect(answer).toBe('bastion_tenant_sites 1');
	});

	it('answers the console with rows it can render', async () => {
		const answer = (await harness().ask('application/json')) as Analytics;
		expect(answer.sites.map((site) => site.site)).toContain('www.example.edu');
		expect(answer.sites.find((site) => site.site === 'www.example.edu')?.requests).toBe(2);
		expect(answer.statuses).toEqual({ '2xx': 2, '5xx': 1 });
		expect(answer.series).toHaveLength(24);
	});

	it('counts an error, which is the number the page puts in front of an operator', async () => {
		const answer = (await harness().ask('application/json')) as Analytics;
		expect(answer.sites.find((site) => site.site === 'www.example.edu')?.errors).toBe(1);
	});

	it('shows a tenant only its own sites', async () => {
		const answer = (await harness().ask('application/json', 'beta')) as Analytics;
		expect(answer.sites.map((site) => site.site)).toEqual(['docs.example.edu']);
	});

	/** a refusal decided before routing belongs to no tenant, so a tenant must not be shown it */
	it('shows refusals with no tenant to an operator and to nobody else', async () => {
		expect(((await harness().ask('application/json')) as Analytics).unattributed).toEqual({
			'rate-limited': 4
		});
		expect(
			((await harness().ask('application/json', 'acme')) as Analytics).unattributed
		).toEqual({});
	});

	it('defaults the window rather than answering nothing without one', async () => {
		const { runtime } = harness();
		const handlers = liveHandlers(runtime, {});
		const answer = (await handlers['GET /api/metrics']?.({
			ctx: {} as Context,
			principal: { id: 'op', role: 'operator', tenant: null, credential: 'session' },
			tenant: null,
			params: {},
			request: new Request('https://127.0.0.1:8787/api/metrics', {
				headers: { accept: 'application/json' }
			})
		})) as { window: { from: number; to: number } };
		expect(answer.window.to - answer.window.from).toBe(24 * 60 * 60 * 1000);
	});
});
