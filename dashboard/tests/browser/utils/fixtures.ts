import type { SiteRow } from '../../../src/components/analytics/Summary.vue';
import type { NodeRow } from '../../../src/components/cluster/Nodes.vue';
import type { LimitRow } from '../../../src/components/LimitsTable.vue';
import type { CapacityAnswer, HealthNode, TenantSummary } from '../../../src/shared/api';

/**
 * What the handlers behind the route table answer.
 *
 * Keyed `METHOD /api/path`, which is how `handleApi` looks a handler up, so a route the dashboard
 * calls and this file does not cover answers 501 rather than silently rendering empty.
 *
 * **Every entry is typed against the interface its consumer declares**, because three of these
 * drifted while the specs stayed green: `severity` written as `state` emptied the health tree's
 * badge column, `lastSeen` for `lastSeenAt` rendered every node as 1970, and the analytics fixture
 * sat under `/api/analytics` while the page calls `/api/metrics`. A blank cell reads as a styling
 * problem, so it survives review; a type error does not.
 *
 * Values exercise a rendering branch each: a warn and an error in the health tree, an assumed
 * capacity term, a declared-not-enforced limit, and a node the control node cannot reach.
 */
interface Fixtures {
	'GET /api/health': { tree: HealthNode };
	'GET /api/capacity': CapacityAnswer;
	'GET /api/doctor': { limits: LimitRow[] };
	'GET /api/tenants': TenantSummary[];
	'GET /api/cluster': { nodes: NodeRow[] };
	'GET /api/config': Record<string, unknown>;
	'GET /api/logs': { lines: { at: number; level: string; message: string; tenant?: string }[] };
	'GET /api/backups': {
		backups: { site: string; version: number; takenAt: number; bytes: number }[];
		certificates: { host: string; expiresAt: number; severity: string; source: string }[];
	};
	'GET /api/audit': {
		ok: boolean;
		entries: { seq: number; at: number; event: string; principal: string }[];
	};
	'GET /api/metrics': { sites: SiteRow[]; statuses: Record<string, number> };
}

export const FIXTURES: Fixtures = {
	'GET /api/health': {
		tree: {
			name: 'node-a',
			severity: 'warn',
			detail: '1 finding open',
			children: [
				{ name: 'front door', severity: 'info', detail: 'listening on 443', children: [] },
				{
					name: 'certificates',
					severity: 'warn',
					detail: 'www.example.edu expires in 14 days',
					children: []
				},
				{
					name: 'backups',
					severity: 'error',
					detail: 'the last drill failed',
					children: []
				}
			]
		}
	},

	'GET /api/capacity': {
		known: true,
		recommended: 32,
		maximum: 40,
		bindingTerm: 'site storage on disk',
		provenance: 'assumed',
		concurrencyCeiling: 18,
		terms: [
			{
				name: 'cores',
				value: 8,
				unit: 'cores',
				provenance: 'probed',
				source: '/proc/cpuinfo'
			},
			{
				name: 'memory',
				value: 16 * 1024 ** 3,
				unit: 'bytes',
				provenance: 'probed',
				source: '/proc/meminfo'
			},
			{
				name: 'resident site RAM',
				value: 97_193_431,
				unit: 'bytes',
				provenance: 'assumed',
				source: 'the re-derived growth ladder, worst case'
			}
		],
		notes: [
			'under `evict` RAM bounds how many sites may be resident AT ONCE (18), not how many may exist'
		]
	},

	'GET /api/doctor': {
		limits: [
			{
				limit: 'isolate memory',
				cloudflare: '128Mi enforced',
				workerd: 'none',
				bastion: '128Mi enforced per tenant'
			},
			{
				limit: 'startup time',
				cloudflare: '1000ms enforced',
				workerd: 'none',
				bastion: '1000ms declared, not enforced'
			},
			{
				limit: 'subrequests',
				cloudflare: '50 enforced',
				workerd: 'none',
				bastion: '50 declared, not enforced'
			}
		]
	},

	'GET /api/tenants': [
		{
			name: 'acme',
			sites: [
				{ host: 'www.example.edu', primary: 'node-a', replicas: ['node-b'] },
				{ host: 'docs.example.edu', primary: 'node-a', replicas: [] }
			],
			limits: { cpu: '2', memory: 4 * 1024 ** 3, pids: 512, maxSites: 40 },
			egress: { allow: ['smtp.example.edu:587'] }
		}
	],

	'GET /api/cluster': {
		nodes: [
			{ id: 'node-a', address: '10.0.0.1:8788', state: 'ready', lastSeenAt: 0 },
			{
				id: 'node-b',
				address: '10.0.0.2:8788',
				state: 'unreachable',
				lastSeenAt: -900_000
			}
		]
	},

	'GET /api/config': {
		version: 1,
		mode: 'solo',
		state: '/var/lib/bastion',
		tenants: [{ name: 'acme', sites: [{ host: 'www.example.edu' }] }]
	},

	'GET /api/logs': {
		lines: [
			{ at: 0, level: 'info', tenant: 'acme', message: 'served 200 for /node/1' },
			{ at: 1000, level: 'warn', tenant: 'acme', message: 'cert expires in 14 days' }
		]
	},

	'GET /api/backups': {
		backups: [
			{ site: 'www.example.edu', version: 2, takenAt: 0, bytes: 5_623_808 },
			{ site: 'www.example.edu', version: 1, takenAt: -86_400_000, bytes: 5_600_000 }
		],
		certificates: [
			{
				host: 'www.example.edu',
				expiresAt: 14 * 86_400_000,
				severity: 'warn',
				source: 'acme'
			},
			{
				host: 'docs.example.edu',
				expiresAt: 80 * 86_400_000,
				severity: 'ok',
				source: 'acme'
			}
		]
	},

	'GET /api/audit': {
		ok: true,
		entries: [
			{ seq: 2, at: 0, event: 'cert.issued', principal: 'ops' },
			{ seq: 1, at: -1000, event: 'tenant.added', principal: 'ops' }
		]
	},

	'GET /api/metrics': {
		sites: [
			{
				site: 'www.example.edu',
				tenant: 'acme',
				requests: 18_402,
				errors: 140,
				refusals: 44,
				cachedFraction: 0.82,
				bytes: 412_000_000,
				p50Ms: 38,
				p95Ms: 310,
				p99Ms: 900
			},
			{
				site: 'docs.example.edu',
				tenant: 'acme',
				requests: 902,
				errors: 0,
				refusals: 0,
				cachedFraction: 0,
				bytes: 12_000_000,
				p50Ms: 52,
				p95Ms: 240,
				p99Ms: 610
			}
		],
		statuses: { '200': 18_900, '304': 220, '404': 140, '503': 44 }
	}
};
