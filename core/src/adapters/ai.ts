/**
 * Workers AI, served by whatever the operator runs.
 *
 * Cloudflare's catalogue is open-weight models, so the same weights run on a box with a GPU. What
 * bastion supplies is the shape: `env.AI.run(model, inputs)` reaches this adapter, which forwards
 * to an inference endpoint. The contract is structural, so ollama, llama.cpp's server, vLLM,
 * LM Studio and anything else speaking the OpenAI-compatible shape satisfy it and bastion depends
 * on none of them.
 *
 * A model the operator has not made available is refused by name rather than silently substituted.
 * Getting a different model than the one asked for is worse than an error: the caller cannot tell.
 */

import type { Context } from '../context';
import { BastionError } from '../errors';

export interface AiRequest {
	model: string;
	inputs: Record<string, unknown>;
	options?: Record<string, unknown>;
}

export interface AiStore {
	id(): string;
	/** the models this endpoint will serve, which is what makes a refusal specific */
	models(): Promise<string[]>;
	run(request: AiRequest): Promise<{ result: unknown } | { stream: ReadableStream }>;
	isReachable(): Promise<boolean>;
}

export function parseAiRequest(body: unknown): AiRequest {
	if (typeof body !== 'object' || body === null) {
		throw new BastionError('usage', 'the ai adapter expects a JSON object');
	}
	const record = body as Record<string, unknown>;
	if (typeof record.model !== 'string' || record.model.trim() === '') {
		throw new BastionError('usage', 'the ai adapter expects a `model`');
	}
	return {
		model: record.model,
		inputs:
			typeof record.inputs === 'object' && record.inputs !== null
				? (record.inputs as Record<string, unknown>)
				: {},
		options:
			typeof record.options === 'object' && record.options !== null
				? (record.options as Record<string, unknown>)
				: {}
	};
}

/**
 * Maps a Workers AI task shape onto the OpenAI-compatible route that serves it.
 *
 * Cloudflare keys on the model name and infers the task; an OpenAI-compatible server keys on the
 * route. Text generation is the overwhelming majority of what a Worker calls, and the two other
 * shapes here are the ones whose request bodies differ enough that guessing would send a
 * well-formed request to the wrong handler.
 */
export function aiRouteFor(inputs: Record<string, unknown>): 'chat' | 'embeddings' | 'completions' {
	if (Array.isArray(inputs.messages)) return 'chat';
	if (inputs.text !== undefined) return 'embeddings';
	return 'completions';
}

export interface OpenAiCompatibleOptions {
	/** e.g. `http://127.0.0.1:11434/v1` for ollama */
	endpoint: string;
	apiKey?: string;
	/** models the operator has made available; empty means ask the endpoint */
	allow?: string[];
}

/**
 * A driver for any endpoint speaking the OpenAI-compatible API.
 *
 * That is one implementation rather than one per server on purpose: ollama, vLLM, llama.cpp and
 * LM Studio all expose the same three routes, so a second driver here would be an abstraction
 * drawn against a difference that does not exist.
 */
export function openAiCompatible(ctx: Context, options: OpenAiCompatibleOptions): AiStore {
	const base = options.endpoint.replace(/\/+$/, '');
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`;
	let cached: string[] | null =
		options.allow !== undefined && options.allow.length > 0 ? options.allow : null;

	const listed = async (): Promise<string[]> => {
		if (cached !== null) return cached;
		const response = await ctx.fetch(`${base}/models`, { headers });
		if (!response.ok) return [];
		const body = (await response.json()) as { data?: { id?: unknown }[] };
		cached = (body.data ?? [])
			.map((entry) => entry.id)
			.filter((id): id is string => typeof id === 'string');
		return cached;
	};

	return {
		id: () => 'openai-compatible',
		models: listed,
		isReachable: async () => {
			try {
				return (await ctx.fetch(`${base}/models`, { headers })).ok;
			} catch {
				return false;
			}
		},
		run: async (request) => {
			const available = await listed();
			// an allow list the operator set is a policy; an empty answer from the endpoint is not,
			// so only the first refuses
			if (available.length > 0 && !available.includes(request.model)) {
				throw new BastionError(
					'driver-refused',
					`this endpoint does not serve ${request.model}; it serves ${available.join(', ')}`,
					{ next: 'bastion config where drivers.ai' }
				);
			}
			const route = aiRouteFor(request.inputs);
			const path =
				route === 'chat'
					? '/chat/completions'
					: route === 'embeddings'
						? '/embeddings'
						: '/completions';
			const body = { model: request.model, ...request.inputs, ...request.options };
			const response = await ctx.fetch(`${base}${path}`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body)
			});
			if (!response.ok) {
				throw new BastionError(
					'driver-refused',
					`the inference endpoint answered ${response.status}`,
					{ retryable: response.status >= 500 }
				);
			}
			if (request.inputs.stream === true && response.body !== null) {
				return { stream: response.body };
			}
			return { result: await response.json() };
		}
	};
}

export interface CloudflareAiOptions {
	accountId: string;
	apiToken: string;
	/** overridden only by a test rig or a proxy the institution requires */
	base?: string;
	/** models this deployment may offload; empty means any, which is the looser posture */
	allow?: string[];
}

/**
 * Workers AI against Cloudflare's own endpoint, which is OPT-IN.
 *
 * bastion assumes self-hosted. This exists because an operator may want one expensive model off
 * their own GPU while everything else stays on the box, and the honest way to offer that is a
 * driver they configure deliberately rather than a fallback that reaches the internet the first
 * time a local endpoint is slow. There is no automatic failover to it for the same reason: a
 * silent egress of tenant prompts to a third party is not something an operator should discover
 * from a bill, and on an air-gapped install it would simply fail with a confusing error.
 */
export function cloudflareAi(ctx: Context, options: CloudflareAiOptions): AiStore {
	const base = (options.base ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
	const root = `${base}/accounts/${options.accountId}/ai`;
	const headers = {
		authorization: `Bearer ${options.apiToken}`,
		'content-type': 'application/json'
	};

	return {
		id: () => 'cloudflare',
		models: async () => {
			if (options.allow !== undefined && options.allow.length > 0) return options.allow;
			const response = await ctx.fetch(`${root}/models/search`, { headers });
			if (!response.ok) return [];
			const body = (await response.json()) as { result?: { name?: unknown }[] };
			return (body.result ?? [])
				.map((entry) => entry.name)
				.filter((name): name is string => typeof name === 'string');
		},
		isReachable: async () => {
			try {
				return (await ctx.fetch(`${root}/models/search`, { headers })).ok;
			} catch {
				return false;
			}
		},
		run: async (request) => {
			// an allow list here is a spend control as much as a policy, so it is checked before
			// the request rather than after the response
			if (
				options.allow !== undefined &&
				options.allow.length > 0 &&
				!options.allow.includes(request.model)
			) {
				throw new BastionError(
					'driver-refused',
					`${request.model} is not on this deployment's offload list`,
					{ next: 'bastion config where drivers.ai' }
				);
			}
			const response = await ctx.fetch(`${root}/run/${request.model}`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ ...request.inputs, ...request.options })
			});
			if (!response.ok) {
				throw new BastionError(
					'driver-refused',
					`cloudflare answered ${response.status} for ${request.model}`,
					{ retryable: response.status >= 500 }
				);
			}
			if (request.inputs.stream === true && response.body !== null) {
				return { stream: response.body };
			}
			const body = (await response.json()) as { result?: unknown };
			return { result: body.result };
		}
	};
}
