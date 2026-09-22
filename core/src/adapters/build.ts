import { resolve, SLOT_CAPABILITY } from '../config/groups';
import type { BastionConfig, DriverConfig, SiteConfig, TenantConfig } from '../config/types';
import type { Context } from '../context';
import { memoryKv } from '../drivers/memory-kv';
import {
	buildCache,
	buildKv,
	buildObjects,
	buildSql,
	type DriverClients
} from '../drivers/registry';
import { BastionError } from '../errors';
import type { DataPointWindow } from '../observe/analytics';
import { cloudflareAi, openAiCompatible, type AiStore } from './ai';
import { ASSET_PROFILES, assetResolver } from './assets';
import { headlessBrowser, type BrowserStore } from './browser';
import { memoryCacheStore } from './cache';
import { smtpEmail, type EmailStore, type SmtpOptions, type SmtpTransport } from './email';
import { commandImages, type ImageStore } from './images';
import { objectKv } from './objects';
import type { AdapterSet } from './server';
import { memoryVectors, remoteVectors, type VectorStore } from './vectors';

/** clients and transports bastion refuses to choose a library for, passed in by the caller */
export interface AdapterClients extends DriverClients {
	smtp?: SmtpTransport;
}

export interface AdapterInput {
	config: BastionConfig;
	tenant: TenantConfig;
	site?: SiteConfig;
	/** this tenant's own state directory; every local driver defaults to somewhere under it */
	state: string;
	/** the window every analytics write lands in; the runtime owns it so `metrics` can read it */
	analytics?: DataPointWindow;
	clients?: AdapterClients;
}

/**
 * Fills in where a local driver keeps its data, under the TENANT's own state directory.
 *
 * Two reasons it is not a constant. The registry's fallbacks were absolute `/var/lib/bastion`
 * paths, so an operator who moved `state:` kept writing to a directory they had not configured and
 * often could not create. And a path shared across tenants is a shared keyspace: a flat `GET foo`
 * from one tenant would read another's value, which makes the tenant boundary a naming convention
 * rather than a boundary. An explicit setting still wins, including one that shares deliberately.
 */
function under(config: DriverConfig, key: string, state: string, name: string): DriverConfig {
	return { [key]: `${state}/${name}`, ...config };
}

function unknown(slot: string, driver: string, known: string[]): never {
	throw new BastionError('driver-refused', `${driver} is not a ${slot} driver bastion knows`, {
		next: `bastion config set drivers.${slot}.driver ${known[0] ?? ''}`.trimEnd()
	});
}

function buildAi(ctx: Context, config: DriverConfig): AiStore {
	const options = config as unknown as Record<string, string | string[] | undefined>;
	if (config.driver === 'cloudflare') {
		return cloudflareAi(ctx, {
			accountId: String(options.accountId ?? ''),
			apiToken: String(options.apiToken ?? ''),
			...(options.base === undefined ? {} : { base: String(options.base) }),
			...(options.allow === undefined ? {} : { allow: options.allow as string[] })
		});
	}
	// one driver rather than one per server: ollama, vLLM, llama.cpp and LM Studio all expose the
	// same three routes, so the names are aliases for the shape rather than implementations
	if (
		['openai-compatible', 'openai', 'ollama', 'vllm', 'llamacpp', 'lmstudio'].includes(
			config.driver
		)
	) {
		return openAiCompatible(ctx, {
			endpoint: String(options.endpoint ?? 'http://127.0.0.1:11434/v1'),
			...(options.apiKey === undefined ? {} : { apiKey: String(options.apiKey) }),
			...(options.allow === undefined ? {} : { allow: options.allow as string[] })
		});
	}
	return unknown('ai', config.driver, ['openai-compatible', 'cloudflare']);
}

function buildVectors(ctx: Context, config: DriverConfig): VectorStore {
	const options = config as unknown as Record<string, unknown>;
	const dimensions = Number(options.dimensions ?? 768);
	const metric = options.metric === undefined ? {} : { metric: options.metric as 'cosine' };
	if (config.driver === 'memory') return memoryVectors({ dimensions, ...metric });
	if (config.driver === 'remote') {
		return remoteVectors(ctx, {
			endpoint: String(options.endpoint ?? ''),
			dimensions,
			...(options.apiKey === undefined ? {} : { apiKey: String(options.apiKey) }),
			...metric
		});
	}
	return unknown('vectorize', config.driver, ['memory', 'remote']);
}

function buildEmail(ctx: Context, config: DriverConfig, clients: AdapterClients): EmailStore {
	if (config.driver !== 'smtp') return unknown('email', config.driver, ['smtp']);
	if (clients.smtp === undefined) {
		throw new BastionError(
			'driver-refused',
			'the smtp email driver needs a transport; pass one in AdapterClients rather than ' +
				'having bastion choose a mail library for you'
		);
	}
	return smtpEmail(ctx, config as unknown as SmtpOptions, clients.smtp);
}

function buildImages(ctx: Context, config: DriverConfig): ImageStore {
	const options = config as unknown as Record<string, unknown>;
	if (!['magick', 'command', 'imagemagick', 'vips'].includes(config.driver)) {
		return unknown('images', config.driver, ['magick', 'vips']);
	}
	return commandImages(ctx, {
		command: String(options.command ?? (config.driver === 'vips' ? 'vipsthumbnail' : 'magick')),
		...(options.maxBytes === undefined ? {} : { maxBytes: Number(options.maxBytes) }),
		...(options.scratch === undefined ? {} : { scratch: String(options.scratch) })
	});
}

function buildBrowser(ctx: Context, config: DriverConfig, egress: string[]): BrowserStore {
	const options = config as unknown as Record<string, unknown>;
	if (!['chromium', 'chrome', 'devtools'].includes(config.driver)) {
		return unknown('browser', config.driver, ['chromium', 'chrome', 'devtools']);
	}
	return headlessBrowser(ctx, {
		command: String(options.command ?? (config.driver === 'chrome' ? 'chrome' : 'chromium')),
		...(options.devtoolsUrl === undefined ? {} : { devtoolsUrl: String(options.devtoolsUrl) }),
		...(options.scratch === undefined ? {} : { scratch: String(options.scratch) }),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: Number(options.timeoutMs) }),
		...(egress.length === 0 ? {} : { allow: egress })
	});
}

/**
 * Every adapter one tenant is served, assembled from the configured drivers.
 *
 * **A slot the tenant may not use is left out rather than built and refused later.** `handleSlot`
 * answers a missing optional store with a refusal that names the slot, so the capability decision
 * is made once here instead of at every request, and a capability withdrawn per site takes its
 * socket with it.
 *
 * The four required slots are always present because the config always carries a driver for them;
 * an unreadable one is a refusal at startup rather than a 500 on the first request.
 */
export function buildAdapters(ctx: Context, input: AdapterInput): AdapterSet {
	const drivers = input.config.drivers;
	const clients = input.clients ?? {};
	const allowed = resolve(input.config, input.tenant, input.site);
	const may = (slot: string): boolean => {
		const capability = SLOT_CAPABILITY[slot];
		return capability !== undefined && allowed.capabilities[capability] === true;
	};

	const profile = ASSET_PROFILES[input.site?.probe ?? ''] ?? ASSET_PROFILES.drupflare;
	const set: AdapterSet = {
		cache: buildCache(ctx, under(drivers.cache, 'root', input.state, 'cache.sqlite')),
		kv: buildKv(ctx, under(drivers.kv, 'path', input.state, 'kv.sqlite'), clients),
		r2: objectKv(buildObjects(ctx, under(drivers.r2, 'root', input.state, 'objects'), clients)),
		queues: buildKv(ctx, under(drivers.queues, 'path', input.state, 'queues.sqlite'), clients),
		assets: assetResolver(ctx.files, `${input.state}/assets`, profile),
		sql: buildSql(under(drivers.d1, 'path', input.state, 'd1.sqlite'), clients),
		tenant: input.tenant.name
	};

	if (drivers.ai !== undefined && may('ai')) set.ai = buildAi(ctx, drivers.ai);
	if (drivers.vectorize !== undefined && may('vectorize')) {
		set.vectorize = buildVectors(ctx, drivers.vectorize);
	}
	if (drivers.email !== undefined && may('email')) {
		set.email = buildEmail(ctx, drivers.email, clients);
	}
	if (drivers.images !== undefined && may('images'))
		set.images = buildImages(ctx, drivers.images);
	if (drivers.browser !== undefined && may('browser')) {
		set.browser = buildBrowser(ctx, drivers.browser, allowed.egress.allow);
	}
	if (input.analytics !== undefined && may('analytics')) set.analytics = input.analytics;
	return set;
}

/**
 * The same set held in memory, for a caller that must not touch a disk or a network.
 *
 * Substituted for {@link buildAdapters} in the gate lane, where the fs cache driver opens a real
 * sqlite file under `state` and the object driver walks a real directory.
 */
export function memoryAdapters(ctx: Context, input: AdapterInput): AdapterSet {
	return {
		cache: memoryCacheStore(ctx.now),
		kv: memoryKv(ctx.now),
		r2: memoryKv(ctx.now),
		queues: memoryKv(ctx.now),
		assets: assetResolver(ctx.files, `${input.state}/assets`, ASSET_PROFILES.drupflare),
		tenant: input.tenant.name,
		...(input.analytics === undefined ? {} : { analytics: input.analytics })
	};
}
