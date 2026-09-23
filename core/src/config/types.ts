/** every isolation mode; the mode chooses the wall around a tenant's process */
export const MODES = ['solo', 'hardened', 'isolated'] as const;
export type Mode = (typeof MODES)[number];

/** whether a Durable Object is evicted after idle or pinned resident */
export const RESIDENCIES = ['evict', 'pin'] as const;
export type Residency = (typeof RESIDENCIES)[number];

export interface ListenerConfig {
	address: string;
}

export interface FrontConfig {
	rateLimit: { perIp: number; perTenant: number };
	maxBodyBytes: number;
	headerTimeoutMs: number;
	maxConnectionsPerIp: number;
	http2: boolean;
	http3: boolean;
	compression: { encodings: string[]; minBytes: number };
	/** CIDRs whose X-Forwarded-For is believed; empty means trust nobody */
	trustedProxies: string[];
}

export interface RuntimeLimits {
	isolateMemory: number;
	startupMs: number;
	subrequests: number;
	alarmMs: number;
}

export interface RuntimeConfig {
	/**
	 * The pinned runtime.
	 *
	 * `digest` is the published SHA-256, when the operator has one. Without it bastion records what
	 * the staged binary hashed and compares on every later start, which catches a swap on disk but
	 * trusts the first sighting.
	 */
	workerd: { version: string; verify: 'sha256' | 'none'; digest?: string };
	floors: { workerd: string; firecracker: string };
	residency: Residency;
	limits: RuntimeLimits;
	unsafeEval: boolean;
	/**
	 * The kernel and root filesystem every guest boots, which only `isolated` reads.
	 *
	 * bastion ships neither: the rootfs carries the pinned workerd and the operator builds it with
	 * `core/scripts/guest-image.sh`. Without this `isolated` has nothing to boot and refuses.
	 *
	 * `firecracker` and `jailer` default to `/usr/bin`, and are here because an operator who
	 * installed the release archive somewhere else otherwise has no way to say so.
	 */
	guest?: { kernel: string; rootfs: string; firecracker?: string; jailer?: string };
}

export interface DriverConfig {
	driver: string;
	[key: string]: unknown;
}

export interface DriversConfig {
	cache: DriverConfig;
	kv: DriverConfig;
	r2: DriverConfig;
	d1: DriverConfig;
	queues: DriverConfig;
	secrets: DriverConfig;
	/** absent means no inference backing, and a site binding AI gets a 501 rather than a guess */
	ai?: DriverConfig;
	vectorize?: DriverConfig;
	images?: DriverConfig;
	email?: DriverConfig;
	/** absent means no headless browser, and a site binding BROWSER is refused rather than guessed */
	browser?: DriverConfig;
}

export interface TenantCapabilities {
	codegen: boolean;
	workerLoader: boolean;
	diagnosticRoutes: boolean;
	extensions: string[];
	adminPhpConsole: boolean;
	/**
	 * Whether a binding may be used at all, separate from whether its backing exists.
	 *
	 * Two different refusals, and conflating them is how an operator ends up debugging the wrong
	 * one. A missing primitive is a HARD no: ImageMagick is not installed, so nothing can bind
	 * Images and no setting changes that. A capability set false here is a POLICY no: the box can
	 * do it and this tenant may not, which is what lets one node serve a department that renders
	 * PDFs beside a student tier that does not.
	 */
	images: boolean;
	browser: boolean;
	ai: boolean;
	vectorize: boolean;
	email: boolean;
	analytics: boolean;
}

/**
 * A named set of settings several tenants share.
 *
 * A cluster is where this earns itself: a group defines the student tier once and every node's
 * configuration names it, so raising a quota or withdrawing a capability is one edit rather than
 * one per tenant per node. Resolution is group, then the tenant's own block, then the site's, and
 * each layer overrides field by field rather than wholesale.
 */
export interface GroupConfig {
	capabilities?: Partial<TenantCapabilities>;
	limits?: TenantLimits;
	egress?: { allow: string[] };
	/** a group may extend another, so a tier is a narrowing of the one above it */
	extends?: string;
}

export interface HeaderRuleConfig {
	path: string;
	set?: Record<string, string>;
	remove?: string[];
}

/**
 * What the bundle exports and what it expects to be bound.
 *
 * Absent means the drupflare shape, which is what every site carried before this block existed. A
 * site that states it is declaring an arbitrary worker: the entrypoint, the object class where
 * there is one, and the binding name per adapter slot. A slot with no name gets no binding and no
 * service, so a worker that wants none of them generates a config with none of them in it.
 */
export interface SiteWorkerConfig {
	/** entry module inside the bundle; inferred when the bundle names one conventionally */
	main?: string;
	/** the class the bundle exports, or null for a worker with no Durable Object */
	durableObjectClass?: string | null;
	/** the binding the object is reached by */
	durableObject?: string;
	/** the binding static assets are served through, or absent to serve none */
	assets?: string;
	kv?: string[];
	r2?: string[];
	queues?: string[];
	/** D1 bindings; workerd has no d1Database field, so each is a wrapped binding over the sql adapter */
	d1?: string[];
	/** Browser rendering bindings, served by the headless browser `drivers.browser` names */
	browser?: string[];
	/** Vectorize bindings, served by whatever index `drivers.vectorize` names */
	vectorize?: string[];
	/** Images bindings, served natively by whatever `drivers.images` names */
	images?: string[];
	/** send_email bindings, served by the smtp server `drivers.email` names */
	email?: string[];
	/** Analytics Engine bindings, served without the flag its native binding is gated behind */
	analytics?: string[];
	/** hyperdrive bindings; a real workerd group, so workerd pools and caches them itself */
	hyperdrive?: {
		name: string;
		database: string;
		user: string;
		password: string;
		scheme: string;
	}[];
	/** the binding a bundle reads version metadata from */
	versionMetadata?: string;
	/** Workers AI bindings, served by whatever inference endpoint `drivers.ai` names */
	ai?: string[];
	compatibilityDate?: string;
	compatibilityFlags?: string[];
}

export interface SiteConfig {
	host: string;
	bundle: string;
	/** the profile that proves a boot; absent for a worker with no CMS behind it */
	probe?: string;
	/** what the bundle exports and expects; absent means the drupflare shape */
	worker?: SiteWorkerConfig;
	/** a group whose settings this site starts from, narrowing whatever the tenant resolved to */
	group?: string;
	/** capabilities withdrawn for this site alone, over whatever the tenant allows */
	capabilities?: Partial<TenantCapabilities>;
	primary?: string;
	replicas?: string[];
	bindings?: Record<string, string>;
	/** other hostnames that reach this site; each one is on the certificate */
	aliases?: string[];
	/** the name aliases redirect to, or absent to serve each alias as itself */
	canonical?: string;
	/** send http to https for this site */
	forceHttps?: boolean;
	headers?: { request?: HeaderRuleConfig[]; response?: HeaderRuleConfig[] };
	/** set once the domain has been proved to belong to this tenant */
	verifiedAt?: number;
}

export interface TenantLimits {
	cpu?: string;
	memory?: number;
	pids?: number;
	maxSites?: number;
}

export interface TenantConfig {
	name: string;
	sites: SiteConfig[];
	limits?: TenantLimits;
	egress?: { allow: string[] };
	capabilities?: Partial<TenantCapabilities>;
	/** a group in `groups`, whose settings this tenant starts from */
	group?: string;
	/**
	 * Stopped, with its state kept.
	 *
	 * Distinct from removing the tenant: a suspended tenant keeps its sites, its storage and its
	 * certificates, and `bastion up` does not start it. That is what makes the state recoverable
	 * rather than a delete an operator has to undo from a backup.
	 */
	suspended?: boolean;
}

export interface DomainsConfig {
	/** the zone every allocated subdomain sits under */
	primary?: string;
	/** labels an operator reserves beyond bastion's own list */
	reserved?: string[];
	/** the addresses this node answers on, which a DNS check compares against */
	addresses?: string[];
	/** whether a name outside the primary domain may be added at all */
	allowCustomRoots?: boolean;
	provider?: { driver: 'none' | 'cloudflare'; [key: string]: unknown };
}

export interface ClusterConfig {
	role: 'control' | 'child';
	control?: { address: string };
	/**
	 * `advertise` is the host OTHER nodes reach this one at.
	 *
	 * It cannot be derived from the listener, because a node binds `0.0.0.0` to accept from every
	 * interface and no peer can dial that. Reported as-is, a node told its peers to reach it at a
	 * wildcard; every forward then resolved to the forwarding node itself and was answered locally,
	 * which reads exactly like a cluster that is working. Defaults to the node id, which is a name
	 * peers already have to resolve to find each other.
	 */
	node: { id: string; advertise?: string; labels?: Record<string, string> };
}

export interface RetentionConfig {
	maxBytes?: number;
	maxAge?: string;
	rotate?: 'hourly' | 'daily' | 'weekly';
}

export interface AuditConfig {
	profile: 'minimal' | 'balanced' | 'everything';
	level: LogLevel;
	events: Record<string, boolean>;
	sinks: { type: string; [key: string]: unknown }[];
	retention: RetentionConfig;
}

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'critical'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogsConfig {
	level: LogLevel;
	retention: RetentionConfig;
	debugRetention: RetentionConfig;
}

export interface BastionConfig {
	version: number;
	mode: Mode;
	state: string;
	listeners: { http?: ListenerConfig; https?: ListenerConfig; management: ListenerConfig };
	front: FrontConfig;
	runtime: RuntimeConfig;
	drivers: DriversConfig;
	tls?: Record<string, unknown>;
	cluster?: ClusterConfig;
	domains?: DomainsConfig;
	audit: AuditConfig;
	logs: LogsConfig;
	backup?: Record<string, unknown>;
	/** named settings a tenant or a site starts from, so a cluster states a tier once */
	groups?: Record<string, GroupConfig>;
	tenants: TenantConfig[];
}
