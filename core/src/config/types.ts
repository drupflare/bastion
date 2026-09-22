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
	workerd: { version: string; verify: 'sha256' | 'none' };
	floors: { workerd: string; firecracker: string };
	residency: Residency;
	limits: RuntimeLimits;
	unsafeEval: boolean;
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
}

export interface TenantCapabilities {
	codegen: boolean;
	workerLoader: boolean;
	diagnosticRoutes: boolean;
	extensions: string[];
	adminPhpConsole: boolean;
}

export interface HeaderRuleConfig {
	path: string;
	set?: Record<string, string>;
	remove?: string[];
}

export interface SiteConfig {
	host: string;
	bundle: string;
	probe: string;
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
	node: { id: string; labels?: Record<string, string> };
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
	tenants: TenantConfig[];
}
