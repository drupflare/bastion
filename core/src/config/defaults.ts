import type { BastionConfig, TenantCapabilities } from './types';

/**
 * Cloudflare's own limits, which are DEFAULTS and FLOORS here.
 *
 * Standalone workerd enforces none of them (`server.c++:4554`, "No limits are enforced"), so a
 * self-hosted site could be given a different machine than the one `worker` is optimised around.
 * A configuration may raise any of these and may never lower one.
 */
export const LIMIT_FLOORS = {
	isolateMemory: 128 * 1024 * 1024,
	startupMs: 1000,
	subrequests: 50,
	/** workerd's own, at `server.c++:4569` */
	alarmMs: 15 * 60 * 1000
} as const;

/**
 * Version floors, each closing a known CVE.
 *
 * `workerd` v1.20231121.0 fixes CVE-2023-48230, a Cap'n Proto crash from WebSocket messages
 * processed in JS or forwarded to a Durable Object -- which is reachable in bastion's own
 * configuration. `firecracker` 1.15.1 fixes CVE-2026-5747; bastion also never passes
 * `--enable-pci`, which closes that path structurally rather than by staying patched.
 */
export const VERSION_FLOORS = {
	workerd: 'v1.20231121.0',
	firecracker: '1.15.1'
} as const;

/** what each floor is protecting, printed by a refusal so it is actionable rather than blunt */
export const FLOOR_REASONS: Record<string, string> = {
	workerd: "CVE-2023-48230, a Cap'n Proto crash reachable over WebSocket and Durable Objects",
	firecracker: 'CVE-2026-5747, a guest-to-host out-of-bounds write in virtio-PCI'
};

/**
 * Worst-case resident memory for one site, from the re-derived growth ladder.
 *
 * Used only to refuse a `pin` configuration that cannot fit; it is never published as a density
 * figure, which the roadmap refuses until the memory section is re-derived against the shipping
 * binary.
 */
export const RESIDENT_SITE_BYTES = 92.69 * 1024 * 1024;

export const DEFAULT_CAPABILITIES: TenantCapabilities = {
	codegen: false,
	workerLoader: false,
	diagnosticRoutes: false,
	extensions: [],
	adminPhpConsole: false
};

export function defaultConfig(): BastionConfig {
	return {
		version: 1,
		mode: 'solo',
		state: '/var/lib/bastion',
		listeners: {
			http: { address: '0.0.0.0:80' },
			https: { address: '0.0.0.0:443' },
			management: { address: '127.0.0.1:8787' }
		},
		front: {
			rateLimit: { perIp: 100, perTenant: 1000 },
			maxBodyBytes: 32 * 1024 * 1024,
			headerTimeoutMs: 10_000,
			maxConnectionsPerIp: 64,
			http2: true,
			http3: false,
			compression: { encodings: ['br', 'gzip'], minBytes: 1024 },
			trustedProxies: []
		},
		runtime: {
			workerd: { version: '1.20260828.1', verify: 'sha256' },
			floors: { ...VERSION_FLOORS },
			residency: 'evict',
			limits: { ...LIMIT_FLOORS },
			unsafeEval: false
		},
		drivers: {
			cache: { driver: 'fs', memoryTier: 256 * 1024 * 1024 },
			kv: { driver: 'sqlite' },
			r2: { driver: 'fs' },
			d1: { driver: 'sqlite' },
			queues: { driver: 'sqlite' },
			secrets: { driver: 'keyring' }
		},
		audit: {
			profile: 'balanced',
			level: 'info',
			events: {},
			sinks: [{ type: 'file' }],
			retention: { maxBytes: 2 * 1024 * 1024 * 1024, maxAge: '90d', rotate: 'daily' }
		},
		logs: {
			level: 'info',
			retention: { maxBytes: 4 * 1024 * 1024 * 1024, maxAge: '14d', rotate: 'daily' },
			debugRetention: { maxBytes: 1024 * 1024 * 1024, maxAge: '2d' }
		},
		domains: {
			reserved: [],
			addresses: [],
			// a custom root needs an ownership proof and a CAA that permits the configured CA, so
			// it is off until an operator decides they want that surface
			allowCustomRoots: false,
			provider: { driver: 'none' }
		},
		tenants: []
	};
}
