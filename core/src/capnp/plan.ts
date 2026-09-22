import { DEFAULT_CAPABILITIES } from '../config/defaults';
import type { SiteConfig, TenantConfig } from '../config/types';
import type {
	BindingSpec,
	CapnpConfig,
	ModuleSpec,
	ServiceSpec,
	SocketSpec,
	WorkerSpec
} from './generate';

/** where a tenant's files live on the node running it */
export interface TenantPaths {
	/** the extracted bundle: site.js plus its wasm modules */
	bundle: string;
	/** workerd's on-disk Durable Object storage for this tenant */
	storage: string;
	/** the site's static assets */
	assets: string;
	/** the unix socket bastion listens on for this tenant's adapter traffic */
	adapterSocket: string;
	/** the unix socket workerd listens on; the front door proxies to it */
	listenSocket: string;
}

export interface PlanInput {
	tenant: TenantConfig;
	site: SiteConfig;
	paths: TenantPaths;
	/** module file names inside the bundle, in load order; the first is the entrypoint */
	modules: ModuleSpec[];
	compatibilityDate: string;
	compatibilityFlags: string[];
	/** a stable, secret-ish value per site; object ids are derived from it */
	uniqueKey: string;
	durableObjectClass: string;
	residency: 'evict' | 'pin';
	/** which binding names the bundle expects for each adapter slot */
	bindings: {
		durableObject: string;
		assets: string;
		kv: string[];
		r2: string[];
		queues: string[];
	};
	/** plain text bindings the bundle reads as vars */
	vars: Record<string, string>;
}

/** the adapter services bastion attaches to every tenant worker */
export const ADAPTER_SERVICES = {
	cache: 'bastion_cache',
	kv: 'bastion_kv',
	r2: 'bastion_r2',
	queues: 'bastion_queues',
	assets: 'bastion_assets',
	assetsDisk: 'bastion_assets_disk',
	storage: 'bastion_storage',
	outbound: 'bastion_outbound'
} as const;

/**
 * Builds the `workerd serve` configuration for one site.
 *
 * Three things here are the measured shape rather than a choice. `cacheApiOutbound` is MANDATORY:
 * without it every `/` answers 500 `No Cache was configured`. KV and R2 are `ServiceDesignator`
 * shapes with no store, so each points at a bastion-hosted service. And the assets service is a
 * WORKER in front of a `disk`, never a bare `disk` -- a bare one answers everything
 * `application/octet-stream`, ignores the ignore list, and served a whole site database publicly
 * in the smoke lane.
 */
export function planSite(input: PlanInput): CapnpConfig {
	const capabilities = { ...DEFAULT_CAPABILITIES, ...(input.tenant.capabilities ?? {}) };
	const services: ServiceSpec[] = [];
	const bindings: BindingSpec[] = [];

	bindings.push({
		name: input.bindings.durableObject,
		kind: 'durableObjectNamespace',
		className: input.durableObjectClass
	});
	bindings.push({
		name: input.bindings.assets,
		kind: 'service',
		service: ADAPTER_SERVICES.assets
	});
	for (const name of input.bindings.kv) {
		bindings.push({ name, kind: 'kvNamespace', service: ADAPTER_SERVICES.kv });
	}
	for (const name of input.bindings.r2) {
		bindings.push({ name, kind: 'r2Bucket', service: ADAPTER_SERVICES.r2 });
	}
	for (const name of input.bindings.queues) {
		bindings.push({ name, kind: 'queue', service: ADAPTER_SERVICES.queues });
	}
	for (const [name, value] of Object.entries(input.vars)) {
		bindings.push({ name, kind: 'text', value });
	}
	// codegen is a capability the product declines by default; the binding is simply absent, which
	// is the only enforcement layer a site cannot reach around
	if (capabilities.codegen) {
		bindings.push({ name: 'UNSAFE_EVAL', kind: 'unsafeEval' });
	}

	const main: WorkerSpec = {
		kind: 'worker',
		name: 'main',
		modules: input.modules,
		compatibilityDate: input.compatibilityDate,
		compatibilityFlags: input.compatibilityFlags,
		cacheApiOutbound: ADAPTER_SERVICES.cache,
		globalOutbound: ADAPTER_SERVICES.outbound,
		durableObjectNamespaces: [
			{
				className: input.durableObjectClass,
				uniqueKey: input.uniqueKey,
				enableSql: true,
				preventEviction: input.residency === 'pin'
			}
		],
		durableObjectStorage: { localDisk: ADAPTER_SERVICES.storage },
		bindings
	};

	services.push(main);
	// every stateful adapter is one bastion-hosted service over a unix socket, so state survives a
	// workerd restart and the CLI can inspect it
	for (const name of [
		ADAPTER_SERVICES.cache,
		ADAPTER_SERVICES.kv,
		ADAPTER_SERVICES.r2,
		ADAPTER_SERVICES.queues,
		ADAPTER_SERVICES.assets
	]) {
		services.push({ kind: 'external', name, address: `unix:${input.paths.adapterSocket}` });
	}
	services.push({
		kind: 'disk',
		name: ADAPTER_SERVICES.storage,
		path: input.paths.storage,
		writable: true
	});
	// deny by default: the config layer of the two-layer egress rule, with the netns underneath it
	services.push({
		kind: 'network',
		name: ADAPTER_SERVICES.outbound,
		allow: [],
		deny: ['public']
	});

	const sockets: SocketSpec[] = [
		{
			name: 'http',
			address: `unix:${input.paths.listenSocket}`,
			service: 'main',
			http: true
		}
	];

	return { services, sockets };
}
