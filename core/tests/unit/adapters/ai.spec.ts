import { describe, expect, it } from 'vitest';
import {
	aiRouteFor,
	cloudflareAi,
	openAiCompatible,
	parseAiRequest,
	type AiStore
} from '../../../src/adapters/ai';
import { memoryCacheStore } from '../../../src/adapters/cache';
import { handleAdapterRequest, type AdapterSet } from '../../../src/adapters/server';
import { defaultContext } from '../../../src/context';
import { memoryKv } from '../../../src/drivers/memory-kv';

/**
 * The inference half of the Workers AI shape.
 *
 * Cloudflare's catalogue is open-weight models, so a box with a GPU serves the same weights. What
 * is worth testing here is the boundary: a model the endpoint does not have is refused by name,
 * and nothing is quietly substituted, because a caller that gets a different model back than the
 * one it asked for has no way to tell.
 */
function ctxWith(routes: Record<string, { status?: number; body: unknown }>) {
	const calls: { url: string; body: unknown }[] = [];
	const ctx = {
		...defaultContext(),
		fetch: async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const matched = Object.entries(routes).find(([path]) => url.includes(path));
			calls.push({
				url,
				body: init?.body === undefined ? null : JSON.parse(String(init.body))
			});
			if (matched === undefined) return new Response('no route', { status: 404 });
			const [, answer] = matched;
			return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
		}
	};
	return { ctx, calls };
}

const listing = { data: [{ id: 'llama-3.1-8b' }, { id: 'bge-base-en' }] };

describe('parseAiRequest', () => {
	it('takes a model and its inputs', () => {
		expect(parseAiRequest({ model: 'm', inputs: { prompt: 'hi' } })).toEqual({
			model: 'm',
			inputs: { prompt: 'hi' },
			options: {}
		});
	});

	it('refuses a body that is not an object', () => {
		expect(() => parseAiRequest('m')).toThrow(/expects a JSON object/);
	});

	it('refuses a request with no model rather than picking one', () => {
		expect(() => parseAiRequest({ inputs: {} })).toThrow(/expects a `model`/);
	});

	it('defaults absent inputs to an empty object', () => {
		expect(parseAiRequest({ model: 'm' }).inputs).toEqual({});
	});
});

describe('aiRouteFor', () => {
	it('sends a message list to chat', () => {
		expect(aiRouteFor({ messages: [] })).toBe('chat');
	});

	it('sends text to embeddings', () => {
		expect(aiRouteFor({ text: 'hello' })).toBe('embeddings');
	});

	it('sends a bare prompt to completions', () => {
		expect(aiRouteFor({ prompt: 'hello' })).toBe('completions');
	});
});

describe('openAiCompatible', () => {
	it('lists what the endpoint serves', async () => {
		const { ctx } = ctxWith({ '/models': { body: listing } });
		expect(await openAiCompatible(ctx, { endpoint: 'http://x/v1' }).models()).toEqual([
			'llama-3.1-8b',
			'bge-base-en'
		]);
	});

	it('refuses a model the endpoint does not have, naming what it does have', async () => {
		const { ctx } = ctxWith({ '/models': { body: listing } });
		const store = openAiCompatible(ctx, { endpoint: 'http://x/v1' });
		await expect(
			store.run({ model: '@cf/meta/llama-4', inputs: { prompt: 'hi' } })
		).rejects.toThrow(/does not serve @cf\/meta\/llama-4; it serves llama-3.1-8b/);
	});

	it('takes the operator allow list over what the endpoint reports', async () => {
		const { ctx, calls } = ctxWith({ '/completions': { body: { choices: [] } } });
		const store = openAiCompatible(ctx, { endpoint: 'http://x/v1', allow: ['pinned'] });
		await store.run({ model: 'pinned', inputs: { prompt: 'hi' } });
		expect(calls.every((c) => !c.url.includes('/models'))).toBe(true);
	});

	it('routes a chat request to chat completions', async () => {
		const { ctx, calls } = ctxWith({
			'/models': { body: listing },
			'/chat/completions': { body: { choices: [{ message: { content: 'hi' } }] } }
		});
		await openAiCompatible(ctx, { endpoint: 'http://x/v1' }).run({
			model: 'llama-3.1-8b',
			inputs: { messages: [{ role: 'user', content: 'hi' }] }
		});
		expect(calls.some((c) => c.url.endsWith('/chat/completions'))).toBe(true);
	});

	it('carries the model into the request body', async () => {
		const { ctx, calls } = ctxWith({
			'/models': { body: listing },
			'/embeddings': { body: { data: [] } }
		});
		await openAiCompatible(ctx, { endpoint: 'http://x/v1' }).run({
			model: 'bge-base-en',
			inputs: { text: 'hello' }
		});
		const sent = calls.find((c) => c.url.endsWith('/embeddings'))?.body as Record<
			string,
			unknown
		>;
		expect(sent.model).toBe('bge-base-en');
		expect(sent.text).toBe('hello');
	});

	it('reports an endpoint that answers as reachable', async () => {
		const { ctx } = ctxWith({ '/models': { body: listing } });
		expect(await openAiCompatible(ctx, { endpoint: 'http://x/v1' }).isReachable()).toBe(true);
	});

	it('reports an endpoint that throws as unreachable rather than propagating', async () => {
		const ctx = {
			...defaultContext(),
			fetch: () => Promise.reject(new Error('econnrefused'))
		};
		expect(await openAiCompatible(ctx, { endpoint: 'http://x/v1' }).isReachable()).toBe(false);
	});

	it('marks a 5xx from the endpoint retryable and a 4xx not', async () => {
		const { ctx } = ctxWith({
			'/models': { body: listing },
			'/completions': { status: 503, body: {} }
		});
		const store = openAiCompatible(ctx, { endpoint: 'http://x/v1' });
		await expect(
			store.run({ model: 'llama-3.1-8b', inputs: { prompt: 'hi' } })
		).rejects.toMatchObject({ retryable: true });
	});

	it('sends the api key where the operator set one', async () => {
		let seen: Record<string, string> | undefined;
		const ctx = {
			...defaultContext(),
			fetch: async (_input: string | URL | Request, init?: RequestInit) => {
				seen = init?.headers as Record<string, string>;
				return new Response(JSON.stringify(listing));
			}
		};
		await openAiCompatible(ctx, { endpoint: 'http://x/v1', apiKey: 'k' }).models();
		expect(seen?.authorization).toBe('Bearer k');
	});

	it('tolerates a trailing slash on the endpoint', async () => {
		const { ctx, calls } = ctxWith({ '/models': { body: listing } });
		await openAiCompatible(ctx, { endpoint: 'http://x/v1/' }).models();
		expect(calls[0]?.url).toBe('http://x/v1/models');
	});
});

describe('the ai slot on the adapter socket', () => {
	const stub: AiStore = {
		id: () => 'stub',
		models: () => Promise.resolve(['a', 'b']),
		isReachable: () => Promise.resolve(true),
		run: (request) => Promise.resolve({ result: { echoed: request.model } })
	};
	const set = (ai?: AiStore): AdapterSet => ({
		cache: memoryCacheStore(),
		kv: memoryKv(),
		r2: memoryKv(),
		queues: memoryKv(),
		assets: () => Promise.resolve(null),
		...(ai === undefined ? {} : { ai })
	});
	const post = (body: unknown, path = '/ai/run') =>
		new Request(`http://a${path}`, { method: 'POST', body: JSON.stringify(body) });

	it('runs a model and answers the result the shim unwraps', async () => {
		const response = await handleAdapterRequest(set(stub), post({ model: 'a', inputs: {} }));
		expect(await response.json()).toEqual({ result: { echoed: 'a' } });
	});

	it('lists the models the endpoint serves', async () => {
		const response = await handleAdapterRequest(set(stub), new Request('http://a/ai/models'));
		expect(await response.json()).toEqual({ models: ['a', 'b'] });
	});

	it('answers 501 with no driver, because the path exists and the backing does not', async () => {
		const response = await handleAdapterRequest(set(), post({ model: 'a', inputs: {} }));
		expect(response.status).toBe(501);
	});

	it('answers 400 for a body with no model', async () => {
		expect((await handleAdapterRequest(set(stub), post({ inputs: {} }))).status).toBe(400);
	});

	it('answers 405 for a GET on run', async () => {
		const response = await handleAdapterRequest(set(stub), new Request('http://a/ai/run'));
		expect(response.status).toBe(405);
	});

	it('answers 404 for a route the adapter does not serve', async () => {
		const response = await handleAdapterRequest(set(stub), new Request('http://a/ai/other'));
		expect(response.status).toBe(404);
	});

	it('turns a driver refusal into a 502 carrying its message', async () => {
		const failing: AiStore = {
			...stub,
			run: () => Promise.reject(new Error('this endpoint does not serve m'))
		};
		const response = await handleAdapterRequest(set(failing), post({ model: 'm', inputs: {} }));
		expect(response.status).toBe(502);
		expect(await response.text()).toContain('does not serve m');
	});

	it('passes a stream through as an event stream', async () => {
		const streaming: AiStore = {
			...stub,
			run: () =>
				Promise.resolve({
					stream: new ReadableStream({
						start(c) {
							c.enqueue(new TextEncoder().encode('data: hi\n\n'));
							c.close();
						}
					})
				})
		};
		const response = await handleAdapterRequest(
			set(streaming),
			post({ model: 'a', inputs: { stream: true } })
		);
		expect(response.headers.get('content-type')).toBe('text/event-stream');
		expect(await response.text()).toContain('data: hi');
	});
});

/**
 * The offload, which is opt-in and never automatic.
 *
 * bastion assumes self-hosted. This driver exists so an operator can put one expensive model on
 * Cloudflare deliberately; what it must not do is become a fallback, because a silent egress of
 * tenant prompts to a third party is not something to discover from a bill.
 */
describe('cloudflareAi', () => {
	it('runs a model against the account endpoint', async () => {
		const { ctx, calls } = ctxWith({
			'/ai/run/': { body: { result: { response: 'hi' } } }
		});
		const answer = await cloudflareAi(ctx, {
			accountId: 'acct',
			apiToken: 't',
			base: 'https://api.test/client/v4'
		}).run({ model: '@cf/meta/llama-3.1-8b-instruct', inputs: { prompt: 'hi' } });
		expect(answer).toEqual({ result: { response: 'hi' } });
		expect(calls[0]?.url).toBe(
			'https://api.test/client/v4/accounts/acct/ai/run/@cf/meta/llama-3.1-8b-instruct'
		);
	});

	it('unwraps cloudflare result envelope rather than handing it back raw', async () => {
		const { ctx } = ctxWith({ '/ai/run/': { body: { result: 42, success: true } } });
		const answer = await cloudflareAi(ctx, {
			accountId: 'a',
			apiToken: 't',
			base: 'https://api.test/client/v4'
		}).run({ model: 'm', inputs: {} });
		expect(answer).toEqual({ result: 42 });
	});

	it('refuses a model outside the offload list before spending the request', async () => {
		const { ctx, calls } = ctxWith({ '/ai/run/': { body: { result: 1 } } });
		const store = cloudflareAi(ctx, {
			accountId: 'a',
			apiToken: 't',
			base: 'https://api.test/client/v4',
			allow: ['@cf/meta/llama-3.1-8b-instruct']
		});
		await expect(store.run({ model: '@cf/other', inputs: {} })).rejects.toThrow(
			/not on this deployment's offload list/
		);
		expect(calls).toHaveLength(0);
	});

	it('reports the allow list as the model list without asking cloudflare', async () => {
		const { ctx, calls } = ctxWith({});
		const models = await cloudflareAi(ctx, {
			accountId: 'a',
			apiToken: 't',
			allow: ['one']
		}).models();
		expect(models).toEqual(['one']);
		expect(calls).toHaveLength(0);
	});

	it('marks a cloudflare 5xx retryable', async () => {
		const { ctx } = ctxWith({ '/ai/run/': { status: 500, body: {} } });
		await expect(
			cloudflareAi(ctx, {
				accountId: 'a',
				apiToken: 't',
				base: 'https://api.test/client/v4'
			}).run({ model: 'm', inputs: {} })
		).rejects.toMatchObject({ retryable: true });
	});

	it('sends the token as a bearer credential', async () => {
		let seen: Record<string, string> | undefined;
		const ctx = {
			...defaultContext(),
			fetch: async (_i: string | URL | Request, init?: RequestInit) => {
				seen = init?.headers as Record<string, string>;
				return new Response(JSON.stringify({ result: [] }));
			}
		};
		await cloudflareAi(ctx, { accountId: 'a', apiToken: 'secret' }).models();
		expect(seen?.authorization).toBe('Bearer secret');
	});

	it('defaults to cloudflare api when no base is given, so nothing points at a local host', () => {
		const { ctx } = ctxWith({});
		expect(cloudflareAi(ctx, { accountId: 'a', apiToken: 't' }).id()).toBe('cloudflare');
	});
});
