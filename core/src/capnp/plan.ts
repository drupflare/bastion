import { DEFAULT_CAPABILITIES } from '../config/defaults';
import type { SiteConfig, TenantConfig } from '../config/types';
import type { Context } from '../context';
import { BastionError } from '../errors';
import type {
	BindingSpec,
	CapnpConfig,
	ExtensionModuleSpec,
	ModuleSpec,
	ServiceSpec,
	SocketSpec,
	WorkerSpec
} from './generate';
import {
	AI_SHIM,
	ANALYTICS_SHIM,
	BROWSER_SHIM,
	D1_SHIM,
	EMAIL_SHIM,
	IMAGES_SHIM,
	SHIM_MODULES,
	VECTORIZE_SHIM
} from './shims';

const MODULE_KINDS: { suffix: string; kind: ModuleSpec['kind'] }[] = [
	{ suffix: '.js', kind: 'esModule' },
	{ suffix: '.mjs', kind: 'esModule' },
	{ suffix: '.wasm', kind: 'wasm' },
	{ suffix: '.json', kind: 'text' },
	{ suffix: '.txt', kind: 'text' },
	{ suffix: '.bin', kind: 'data' }
];

/** the names an entrypoint is inferred from, in order, when the bundle does not state one */
export const ENTRYPOINT_NAMES = ['index.js', 'index.mjs', 'worker.js', 'main.js', 'site.js'];

function kindOf(name: string): ModuleSpec['kind'] | null {
	for (const entry of MODULE_KINDS) if (name.endsWith(entry.suffix)) return entry.kind;
	return null;
}

/**
 * A path `embed` will accept, which is one relative to the file holding it.
 *
 * Cap'n Proto resolves an `embed` against the directory of the capnp it appears in and refuses an
 * absolute path outright: `Couldn't read file for embed: /work/bundle/index.js`. The generated
 * config lives under the tenant's state and the bundle lives wherever the operator put it, so the
 * two are only ever the same directory by accident. They were in the first rig that booted, which
 * is why this held until a config was written somewhere real.
 */
export function embedPath(from: string, to: string): string {
	const fromParts = from.replace(/\/+$/, '').split('/').filter(Boolean);
	const toParts = to.replace(/\/+$/, '').split('/').filter(Boolean);
	let shared = 0;
	while (
		shared < fromParts.length &&
		shared < toParts.length &&
		fromParts[shared] === toParts[shared]
	) {
		shared += 1;
	}
	const up = Array(fromParts.length - shared).fill('..');
	const down = toParts.slice(shared);
	const relative = [...up, ...down].join('/');
	return relative === '' ? '.' : relative;
}

/**
 * Reads a bundle directory into the module list `planSite` takes.
 *
 * The entrypoint has to come first, and it is only guessed where the answer is unambiguous: a
 * bundle carrying three scripts and naming none of them is a caller mistake, and picking one would
 * deploy a worker that starts and serves the wrong module.
 */
export function modulesFrom(
	ctx: Context,
	bundle: string,
	main?: string,
	/** the directory the generated config will be written to; embeds are resolved against it */
	configDir = bundle
): ModuleSpec[] {
	const names = ctx.files
		.readDir(bundle)
		.filter((entry) => !entry.directory)
		.map((entry) => entry.name)
		.filter((name) => kindOf(name) !== null)
		.sort();
	if (names.length === 0) {
		throw new BastionError('usage', `the bundle at ${bundle} holds no modules`, {
			next: 'bastion site show'
		});
	}

	const scripts = names.filter((name) => kindOf(name) === 'esModule');
	let entry = main;
	if (entry === undefined) {
		entry = ENTRYPOINT_NAMES.find((candidate) => scripts.includes(candidate));
	}
	if (entry === undefined && scripts.length === 1) entry = scripts[0];
	if (entry === undefined) {
		throw new BastionError(
			'usage',
			scripts.length === 0
				? `the bundle at ${bundle} holds no javascript, so it has no entrypoint`
				: `the bundle at ${bundle} holds ${scripts.length} scripts and none is named index.js, so name one`,
			{ next: 'bastion config set' }
		);
	}
	if (!names.includes(entry)) {
		throw new BastionError('usage', `the bundle at ${bundle} has no module called ${entry}`, {
			next: 'bastion site show'
		});
	}

	const ordered = [entry, ...names.filter((name) => name !== entry)];
	const prefix = embedPath(configDir, bundle);
	return ordered.map((name) => ({
		name,
		kind: kindOf(name) as ModuleSpec['kind'],
		embed: prefix === '.' ? name : `${prefix}/${name}`
	}));
}

/** where a tenant's files live on the node running it */
export interface TenantPaths {
	/** the extracted bundle: site.js plus its wasm modules */
	bundle: string;
	/** workerd's on-disk Durable Object storage for this tenant */
	storage: string;
	/** the site's static assets */
	assets: string;
	/**
	 * Where this tenant's adapter sockets live, one file per slot.
	 *
	 * One socket per adapter rather than one shared socket, because workerd addresses an `external`
	 * service by its ADDRESS and sends whatever path the runtime generates: a KV read arrives as
	 * `GET /<key>`, with nothing naming the slot it came from. Sharing a socket made every native
	 * designator indistinguishable from the others, and the smoke rig never caught it because it
	 * backed KV with a worker instead of a socket.
	 */
	adapterDir: string;
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
	/** the class the bundle exports, or absent for a worker that has no Durable Object */
	durableObjectClass?: string;
	residency: 'evict' | 'pin';
	/** which binding names the bundle expects for each adapter slot; each one is optional */
	bindings: {
		durableObject?: string;
		assets?: string;
		kv?: string[];
		r2?: string[];
		queues?: string[];
		/** each becomes a wrapped binding presenting the D1 api over the sql adapter */
		d1?: string[];
		/** each becomes a wrapped binding presenting the Vectorize api over the vector index */
		vectorize?: string[];
		/** each becomes a wrapped binding presenting the Images api over the host's image tool */
		images?: string[];
		/** each becomes a wrapped binding presenting browser rendering over a headless browser */
		browser?: string[];
		/** each becomes a wrapped binding presenting send_email over the operator's smtp server */
		email?: string[];
		/** each becomes a wrapped binding presenting Analytics Engine without --experimental */
		analytics?: string[];
		/** hyperdrive is a REAL group in the schema, so it is emitted rather than shimmed */
		hyperdrive?: {
			name: string;
			database: string;
			user: string;
			password: string;
			scheme: string;
		}[];
		/** the version metadata a bundle reads; bastion owns its version store, so this is known */
		versionMetadata?: string;
		/** each becomes a wrapped binding presenting the Workers AI api over the ai adapter */
		ai?: string[];
	};
	/** plain text bindings the bundle reads as vars */
	vars: Record<string, string>;
}

/**
 * The socket one adapter service listens on.
 *
 * Derived from the service name so the generator and whatever binds the socket cannot disagree
 * about where it is. A path over 100 bytes is refused by the kernel on both Linux and macOS
 * (`sun_path` is 108 and 104 bytes), and a tenant name plus a state directory reaches that sooner
 * than it looks, so the caller is told rather than left with a bind that fails at startup.
 */
export function socketFor(paths: Pick<TenantPaths, 'adapterDir'>, service: string): string {
	const path = `${paths.adapterDir}/${service.replace(/^bastion_/, '')}.sock`;
	if (path.length > 100) {
		throw new BastionError(
			'usage',
			`the adapter socket path is ${path.length} bytes and the kernel accepts 100; shorten \`state\``,
			{ next: 'bastion config set state' }
		);
	}
	return path;
}

/** the adapter services bastion attaches to every tenant worker */
export const ADAPTER_SERVICES = {
	cache: 'bastion_cache',
	kv: 'bastion_kv',
	r2: 'bastion_r2',
	queues: 'bastion_queues',
	sql: 'bastion_sql',
	vectorize: 'bastion_vectorize',
	images: 'bastion_images',
	browser: 'bastion_browser',
	email: 'bastion_email',
	analytics: 'bastion_analytics',
	ai: 'bastion_ai',
	assets: 'bastion_assets',
	assetsDisk: 'bastion_assets_disk',
	storage: 'bastion_storage',
	outbound: 'bastion_outbound'
} as const;

/**
 * Every Cloudflare binding bastion serves through a wrapped module.
 *
 * The entries share one mechanism, so this is a table rather than a branch per binding: a new one
 * is a shim, an adapter slot and a row here. Each is a Cloudflare API with no field in workerd's
 * schema and a self-hostable thing underneath it, which is what makes the shape reproducible at
 * all -- an API whose backing only exists inside Cloudflare's network is not on this list.
 */
export const WRAPPED_SLOTS = [
	{
		key: 'd1',
		moduleName: SHIM_MODULES.d1,
		service: ADAPTER_SERVICES.sql,
		shim: D1_SHIM,
		// sqlite is compiled in, so this slot has a backing on every host with no operator action
		driver: null,
		needs: null
	},
	{
		key: 'vectorize',
		moduleName: SHIM_MODULES.vectorize,
		service: ADAPTER_SERVICES.vectorize,
		shim: VECTORIZE_SHIM,
		driver: 'vectorize',
		needs: 'an index: set drivers.vectorize with its dimensions'
	},
	{
		key: 'ai',
		moduleName: SHIM_MODULES.ai,
		service: ADAPTER_SERVICES.ai,
		shim: AI_SHIM,
		driver: 'ai',
		needs: 'an inference endpoint: run one and set drivers.ai.endpoint'
	},
	{
		key: 'images',
		moduleName: SHIM_MODULES.images,
		service: ADAPTER_SERVICES.images,
		shim: IMAGES_SHIM,
		driver: 'images',
		needs: 'an image tool: install imagemagick and set drivers.images'
	},
	{
		key: 'browser',
		moduleName: SHIM_MODULES.browser,
		service: ADAPTER_SERVICES.browser,
		shim: BROWSER_SHIM,
		driver: 'browser',
		needs: 'a headless browser: install chromium and set drivers.browser'
	},
	{
		key: 'email',
		moduleName: SHIM_MODULES.email,
		service: ADAPTER_SERVICES.email,
		shim: EMAIL_SHIM,
		driver: 'email',
		needs: 'a mail server: set drivers.email with its host'
	},
	{
		key: 'analytics',
		moduleName: SHIM_MODULES.analytics,
		service: ADAPTER_SERVICES.analytics,
		shim: ANALYTICS_SHIM,
		// a bounded ring in bastion's own process, so there is nothing for an operator to install
		driver: null,
		needs: null
	}
] as const satisfies readonly {
	key: 'd1' | 'vectorize' | 'ai' | 'images' | 'browser' | 'email' | 'analytics';
	moduleName: string;
	service: string;
	shim: string;
	/** the `drivers` key that must be configured, or null where the backing is always present */
	driver: string | null;
	/** what the operator has to do, named in the refusal so it is not left to guess */
	needs: string | null;
}[];

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

	const object =
		input.durableObjectClass !== undefined && input.bindings.durableObject !== undefined
			? { name: input.bindings.durableObject, className: input.durableObjectClass }
			: null;
	if (object !== null) {
		bindings.push({
			name: object.name,
			kind: 'durableObjectNamespace',
			className: object.className
		});
	}
	if (input.bindings.assets !== undefined) {
		bindings.push({
			name: input.bindings.assets,
			kind: 'service',
			service: ADAPTER_SERVICES.assets
		});
	}
	for (const name of input.bindings.kv ?? []) {
		bindings.push({ name, kind: 'kvNamespace', service: ADAPTER_SERVICES.kv });
	}
	for (const name of input.bindings.r2 ?? []) {
		bindings.push({ name, kind: 'r2Bucket', service: ADAPTER_SERVICES.r2 });
	}
	for (const name of input.bindings.queues ?? []) {
		bindings.push({ name, kind: 'queue', service: ADAPTER_SERVICES.queues });
	}
	// none of these has a field in workerd's schema, so each is built out of the one binding that
	// can carry an arbitrary api: an internal module handed a service fetcher. Adding the next one
	// is an entry in WRAPPED_SLOTS plus its shim, not another branch here
	for (const slot of WRAPPED_SLOTS) {
		for (const name of input.bindings[slot.key] ?? []) {
			bindings.push({
				name,
				kind: 'wrapped',
				moduleName: slot.moduleName,
				innerBindings: [{ name: 'fetcher', kind: 'service', service: slot.service }]
			});
		}
	}
	// hyperdrive is NOT a shim. `hyperdrive @18-22` is a real group in the schema, so workerd does
	// its own pooling and caching against whatever the designator names, and bastion names its own
	// sql adapter. Serving it through a wrapped module would throw that pooling away
	for (const entry of input.bindings.hyperdrive ?? []) {
		bindings.push({
			name: entry.name,
			kind: 'hyperdrive',
			service: ADAPTER_SERVICES.sql,
			database: entry.database,
			user: entry.user,
			password: entry.password,
			scheme: entry.scheme
		});
	}
	// bastion owns the version store, so the metadata a bundle reads is already known here and is
	// a plain json binding rather than anything that has to be asked for at runtime
	if (input.bindings.versionMetadata !== undefined) {
		bindings.push({
			name: input.bindings.versionMetadata,
			kind: 'json',
			value: { id: input.uniqueKey, tag: input.site.host, timestamp: input.compatibilityDate }
		});
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
		bindings
	};
	// a worker with no object gets no namespace and no storage: naming a class the bundle does not
	// export is a config workerd refuses to start, so the absence has to travel all the way through
	if (object !== null) {
		main.durableObjectNamespaces = [
			{
				className: object.className,
				uniqueKey: input.uniqueKey,
				enableSql: true,
				preventEviction: input.residency === 'pin'
			}
		];
		main.durableObjectStorage = { localDisk: ADAPTER_SERVICES.storage };
	}

	services.push(main);
	// every stateful adapter is one bastion-hosted service over a unix socket, so state survives a
	// workerd restart and the CLI can inspect it. cache is unconditional: without `cacheApiOutbound`
	// every `/` answers 500
	const attached: string[] = [ADAPTER_SERVICES.cache];
	if ((input.bindings.kv ?? []).length > 0) attached.push(ADAPTER_SERVICES.kv);
	if ((input.bindings.r2 ?? []).length > 0) attached.push(ADAPTER_SERVICES.r2);
	if ((input.bindings.queues ?? []).length > 0) attached.push(ADAPTER_SERVICES.queues);
	for (const slot of WRAPPED_SLOTS) {
		if ((input.bindings[slot.key] ?? []).length > 0) attached.push(slot.service);
	}
	// hyperdrive designates the same sql service, so it attaches it without being a wrapped slot
	if ((input.bindings.hyperdrive ?? []).length > 0 && !attached.includes(ADAPTER_SERVICES.sql)) {
		attached.push(ADAPTER_SERVICES.sql);
	}
	if (input.bindings.assets !== undefined) attached.push(ADAPTER_SERVICES.assets);
	for (const name of attached) {
		services.push({ kind: 'external', name, address: `unix:${socketFor(input.paths, name)}` });
	}
	if (object !== null) {
		services.push({
			kind: 'disk',
			name: ADAPTER_SERVICES.storage,
			path: input.paths.storage,
			writable: true
		});
	}
	// deny by default, the config layer of the two-layer egress rule with the netns underneath
	// an empty `allow` is "reach nothing"; `deny = ["public"]` reads the same and refuses to start
	services.push({
		kind: 'network',
		name: ADAPTER_SERVICES.outbound,
		allow: []
	});

	const sockets: SocketSpec[] = [
		{
			name: 'http',
			address: `unix:${input.paths.listenSocket}`,
			service: 'main',
			http: true
		}
	];

	// a shim module is declared only when something binds it, so a site that wants none of them
	// ships no javascript bastion wrote into its tenant
	const extensionModules: ExtensionModuleSpec[] = [];
	for (const slot of WRAPPED_SLOTS) {
		if ((input.bindings[slot.key] ?? []).length === 0) continue;
		extensionModules.push({ name: slot.moduleName, internal: true, esModule: slot.shim });
	}

	return extensionModules.length === 0
		? { services, sockets }
		: { services, sockets, extensionModules };
}
