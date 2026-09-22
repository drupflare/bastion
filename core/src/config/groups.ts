/**
 * Resolving what a tenant or a site is actually allowed to do.
 *
 * Three layers, narrowing: the group it names, then the tenant's own block, then the site's. Each
 * overrides field by field rather than wholesale, so a site withdrawing one capability keeps every
 * other value the tier set.
 *
 * **A capability can only ever be narrowed on the way down.** A site cannot turn on what its
 * tenant turned off, and a tenant cannot turn on what its group turned off. Without that rule a
 * delegated tenant-admin could grant themselves back whatever the operator withdrew, which makes
 * the whole block decorative -- and a capability that reads enforced and is not is the exact
 * failure this project exists to prevent.
 */

import { DEFAULT_CAPABILITIES } from './defaults';
import type {
	BastionConfig,
	GroupConfig,
	SiteConfig,
	TenantCapabilities,
	TenantConfig,
	TenantLimits
} from './types';

export interface Resolved {
	capabilities: TenantCapabilities;
	limits: TenantLimits;
	egress: { allow: string[] };
	/** every group that contributed, outermost first, so `doctor` can say where a value came from */
	chain: string[];
}

/** how deep a group may extend before bastion calls it a cycle rather than a hierarchy */
export const MAX_GROUP_DEPTH = 8;

/**
 * Walks a group's `extends` chain, outermost first.
 *
 * A cycle is refused by depth rather than by tracking visited names, because the depth cap is also
 * the answer for a chain that is merely absurd, and an operator reading "more than 8 groups deep"
 * learns more than one reading "cycle".
 */
export function groupChain(
	groups: Record<string, GroupConfig> | undefined,
	name: string | undefined
): GroupConfig[] {
	if (name === undefined || groups === undefined) return [];
	const chain: GroupConfig[] = [];
	let current: string | undefined = name;
	const seen = new Set<string>();
	while (current !== undefined && chain.length < MAX_GROUP_DEPTH) {
		if (seen.has(current)) break;
		seen.add(current);
		const group: GroupConfig | undefined = groups[current];
		if (group === undefined) break;
		chain.unshift(group);
		current = group.extends;
	}
	return chain;
}

/** the names in that chain, for a message that says where a setting came from */
export function groupNames(
	groups: Record<string, GroupConfig> | undefined,
	name: string | undefined
): string[] {
	if (name === undefined || groups === undefined) return [];
	const names: string[] = [];
	let current: string | undefined = name;
	const seen = new Set<string>();
	while (current !== undefined && names.length < MAX_GROUP_DEPTH) {
		if (seen.has(current) || groups[current] === undefined) break;
		seen.add(current);
		names.unshift(current);
		current = groups[current]?.extends;
	}
	return names;
}

/** false anywhere in the chain wins, whatever a later layer says */
function narrow(
	base: TenantCapabilities,
	over: Partial<TenantCapabilities> | undefined
): TenantCapabilities {
	if (over === undefined) return base;
	const out = { ...base };
	for (const [key, value] of Object.entries(over)) {
		if (key === 'extensions') {
			// an empty catalogue means nobody has set one yet, so the first layer to name a set
			// establishes it and every layer below narrows to the intersection. Treating `[]` as
			// an explicit deny would collapse every tier to nothing, since the root default is `[]`
			const wanted = value as string[];
			out.extensions =
				base.extensions.length === 0
					? [...wanted]
					: wanted.filter((entry) => base.extensions.includes(entry));
			continue;
		}
		if (typeof value !== 'boolean') continue;
		out[key as Exclude<keyof TenantCapabilities, 'extensions'>] =
			base[key as Exclude<keyof TenantCapabilities, 'extensions'>] === false ? false : value;
	}
	return out;
}

/**
 * What this tenant, and optionally this site, resolves to.
 *
 * The site argument is what makes a per-site withdrawal work: one department's tenant may render
 * PDFs while one site inside it may not, and both are stated where somebody reading the config
 * expects to find them.
 */
export function resolve(
	config: Pick<BastionConfig, 'groups'>,
	tenant: TenantConfig,
	site?: SiteConfig
): Resolved {
	const groups = config.groups;
	// the root of every tier is the shipped default, which declines codegen and every optional
	// binding, so a group that states nothing grants nothing
	let capabilities: TenantCapabilities = { ...DEFAULT_CAPABILITIES };
	let limits: TenantLimits = {};
	let egress: string[] = [];
	const chain = [...groupNames(groups, tenant.group), ...groupNames(groups, site?.group)];

	for (const group of [...groupChain(groups, tenant.group), ...groupChain(groups, site?.group)]) {
		capabilities = narrow(capabilities, group.capabilities);
		limits = { ...limits, ...(group.limits ?? {}) };
		if (group.egress !== undefined) egress = group.egress.allow;
	}

	capabilities = narrow(capabilities, tenant.capabilities);
	limits = { ...limits, ...(tenant.limits ?? {}) };
	if (tenant.egress !== undefined) egress = tenant.egress.allow;

	if (site !== undefined) capabilities = narrow(capabilities, site.capabilities);

	return { capabilities, limits, egress: { allow: egress }, chain };
}

/** the capability that governs each binding slot, so one table answers both questions */
export const SLOT_CAPABILITY: Record<string, keyof TenantCapabilities> = {
	images: 'images',
	browser: 'browser',
	ai: 'ai',
	vectorize: 'vectorize',
	email: 'email',
	analytics: 'analytics'
};
