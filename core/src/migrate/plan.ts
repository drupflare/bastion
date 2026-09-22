import type { CapacityAnswer } from '../capacity/model';
import { admitSite } from '../capacity/model';
import { BastionError } from '../errors';

export type MigrationSource = 'vps' | 'drupflare' | 'cloudflare';

export interface DiscoveredSite {
	host: string;
	source: MigrationSource;
	/** bytes of database plus files, as the survey measured them */
	sizeBytes: number;
	cms: string | null;
	/** anything the survey could not read, named rather than skipped silently */
	warnings: string[];
}

export interface CarryItem {
	what: string;
	carries: boolean;
	reason: string;
}

export interface SitePlan {
	site: DiscoveredSite;
	tenant: string;
	/** false when the destination cannot take it, with the reason in `blockedBy` */
	fits: boolean;
	blockedBy: string | null;
	carries: CarryItem[];
}

export interface MigrationPlan {
	source: MigrationSource;
	sites: SitePlan[];
	/** what this move will not bring across, listed before the operator commits */
	notCarried: string[];
	totalBytes: number;
	destination: { node: string; recommended: number; maximum: number; bindingTerm: string };
}

/**
 * What a drupflare export carries and what it does not.
 *
 * The done condition the roadmap sets is that a conversion produces sites rendering byte-identical
 * to the origin AND that anything it could not carry is named. A migration that silently drops
 * something is one that produces a support ticket three weeks later, so the list is part of the
 * plan rather than part of the postmortem.
 */
export const CARRY_TABLE: CarryItem[] = [
	{ what: 'database', carries: true, reason: 'the chunked replay the smoke lane already proved' },
	{ what: 'uploaded files', carries: true, reason: 'the export artifact carries them' },
	{ what: 'modules and themes', carries: true, reason: 'part of the site bundle' },
	{ what: 'configuration', carries: true, reason: 'part of the database' },
	{ what: 'cron schedule', carries: true, reason: 'bastion owns the scheduler' },
	{
		what: 'PHP extensions the origin had compiled in',
		carries: false,
		reason:
			'a user-supplied library cannot be a PHP extension at all; the operator publishes a ' +
			'catalogue and the tenant selects from it'
	},
	{
		what: 'server-level rewrites and .htaccess',
		carries: false,
		reason: "there is no Apache here; the front door's routing replaces them"
	},
	{
		what: 'cron entries outside the CMS',
		carries: false,
		reason: 'a system crontab belongs to the origin host'
	},
	{
		what: 'TLS certificates',
		carries: false,
		reason: 'bastion issues its own; import an institutional chain with `bastion cert import`'
	},
	{
		what: 'server mail configuration',
		carries: false,
		reason: 'a Worker has no local MTA; point the site at an SMTP relay in the egress allow list'
	}
];

/**
 * Builds the plan both front ends render.
 *
 * One planner, two front ends: the interactive CLI wizard and the dashboard render this same
 * object, so they cannot diverge because neither computes it.
 *
 * **Multi-site is the assumption rather than an option.** A VPS is surveyed for every site on it;
 * asking a customer to enumerate their own sites is the moment a migration demo dies.
 */
export function buildPlan(input: {
	source: MigrationSource;
	discovered: DiscoveredSite[];
	tenant: string;
	node: string;
	capacity: CapacityAnswer;
	currentSites: number;
	maxSites?: number;
}): MigrationPlan {
	const sites: SitePlan[] = [];
	let held = input.currentSites;

	for (const site of input.discovered) {
		let fits = true;
		let blockedBy: string | null = null;
		try {
			admitSite(held, input.capacity, input.maxSites);
			held += 1;
		} catch (e) {
			fits = false;
			blockedBy = e instanceof Error ? e.message : String(e);
		}
		sites.push({ site, tenant: input.tenant, fits, blockedBy, carries: CARRY_TABLE });
	}

	return {
		source: input.source,
		sites,
		notCarried: CARRY_TABLE.filter((item) => !item.carries).map(
			(item) => `${item.what}: ${item.reason}`
		),
		totalBytes: input.discovered.reduce((n, site) => n + site.sizeBytes, 0),
		destination: {
			node: input.node,
			recommended: input.capacity.recommended,
			maximum: input.capacity.maximum,
			bindingTerm: input.capacity.bindingTerm
		}
	};
}

export function assertPlanFits(plan: MigrationPlan): void {
	const blocked = plan.sites.filter((site) => !site.fits);
	if (blocked.length === 0) return;
	throw new BastionError(
		'capacity-exceeded',
		`${blocked.length} of ${plan.sites.length} sites do not fit on ${plan.destination.node}: ` +
			blocked.map((site) => site.site.host).join(', '),
		{ next: 'bastion capacity' }
	);
}
