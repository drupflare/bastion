import type { Context } from '@drupflare/bastion';
import {
	BastionError,
	LARGE_RANGE_FLAG,
	NodeRegistry,
	buildPlan,
	capacity,
	checkRange,
	defaultCostModel,
	expandCidr,
	installCommands,
	planPlacement,
	planPromotion,
	provision,
	readHost,
	refusingTransport,
	type DiscoveredSite
} from '@drupflare/bastion';
import { kv, table } from '../format';
import { emit, load, type Globals } from '../state';

export function runClusterNodes(ctx: Context, globals: Globals): void {
	const loaded = load(ctx, globals);
	const registry = new NodeRegistry(ctx);
	const self = loaded.config.cluster?.node;
	if (self !== undefined) {
		registry.join(self.id, loaded.config.listeners.management.address, self.labels ?? {});
	}
	const nodes = registry.list();
	emit(ctx, globals, { nodes }, () =>
		nodes.length === 0
			? 'this node is not in a cluster; run `bastion cluster init`'
			: table(
					['node', 'address', 'state', 'last seen'],
					nodes.map((node) => [
						node.id,
						node.address,
						node.state,
						new Date(node.lastSeenAt).toISOString()
					])
				)
	);
}

export function runClusterPlace(
	ctx: Context,
	globals: Globals & { replicas?: string },
	site: string
): void {
	const loaded = load(ctx, globals);
	const registry = new NodeRegistry(ctx);
	const self = loaded.config.cluster?.node;
	if (self === undefined) {
		throw new BastionError('usage', 'this node is not in a cluster', {
			next: 'bastion cluster init'
		});
	}
	registry.join(self.id, loaded.config.listeners.management.address, self.labels ?? {});
	const tenant =
		loaded.config.tenants.find((entry) => entry.sites.some((s) => s.host === site))?.name ?? '';
	if (tenant === '') throw new BastionError('usage', `no tenant holds ${site}`);
	const placed = planPlacement({
		site,
		tenant,
		nodes: registry.list(),
		replicas: Number(globals.replicas ?? '0')
	});
	emit(ctx, globals, placed, () =>
		kv([
			['site', placed.site],
			['tenant', placed.tenant],
			['primary', placed.primary],
			['replicas', placed.replicas.join(', ') || '(none)']
		])
	);
}

export function runClusterPromote(
	ctx: Context,
	globals: Globals,
	site: string,
	node: string
): number {
	const loaded = load(ctx, globals);
	const tenant = loaded.config.tenants.find((entry) => entry.sites.some((s) => s.host === site));
	const configured = tenant?.sites.find((s) => s.host === site);
	if (tenant === undefined || configured === undefined) {
		throw new BastionError('usage', `no tenant holds ${site}`);
	}
	const placement = {
		site,
		tenant: tenant.name,
		primary: configured.primary ?? '',
		replicas: configured.replicas ?? []
	};
	const plan = planPromotion(placement, node, null, ctx.now());
	emit(ctx, globals, plan, () =>
		[
			kv([
				['site', plan.site],
				['from', plan.from],
				['to', plan.to],
				['worst-case write loss', `${plan.worstCaseLossMs}ms`]
			]),
			'',
			plan.warning,
			'',
			globals.yes === true ? 'promoting' : 'pass --yes to promote'
		].join('\n')
	);
	return globals.yes === true ? 0 : 3;
}

export async function runClusterProvision(
	ctx: Context,
	globals: Globals & {
		dryRun?: boolean;
		only?: string;
		exclude?: string;
		iKnowThisIsALargeRange?: boolean;
	},
	target: string
): Promise<number> {
	const loaded = load(ctx, globals);
	const options = {
		controlAddress:
			loaded.config.cluster?.control?.address ?? loaded.config.listeners.management.address,
		joinToken: '(minted at run time)',
		version: loaded.config.runtime.workerd.version,
		principal: 'operator',
		dryRun: globals.dryRun,
		yes: globals.yes,
		acknowledgeLargeRange: globals.iKnowThisIsALargeRange,
		...(globals.only === undefined ? {} : { only: globals.only.split(',') }),
		...(globals.exclude === undefined ? {} : { exclude: globals.exclude.split(',') })
	};

	const isRange = target.includes('/');
	const hosts = isRange ? expandCidr(target) : [target];
	if (isRange) {
		const allowed = checkRange(target, options);
		if (!allowed.ok) {
			ctx.io.err(allowed.reason);
			ctx.io.err(`the flag is ${LARGE_RANGE_FLAG}`);
			return 2;
		}
	}

	const outcomes = await provision(
		hosts.map((host) => ({ target: { host }, transport: refusingTransport(host) })),
		{ ...options, dryRun: options.dryRun ?? isRange }
	);
	emit(ctx, globals, { outcomes, commands: installCommands(options) }, () =>
		table(
			['host', 'action', 'reason'],
			outcomes.map((outcome) => [outcome.host, outcome.action, outcome.reason])
		)
	);
	return 0;
}

export function runMigratePlan(ctx: Context, globals: Globals, source: string): void {
	const loaded = load(ctx, globals);
	const host = readHost(ctx, loaded.state);
	const answer = capacity(host, defaultCostModel(loaded.config.mode), {
		residency: loaded.config.runtime.residency,
		tenants: Math.max(1, loaded.config.tenants.length)
	});
	// the survey itself is drangler's; this is the destination half plus the carry table
	const discovered: DiscoveredSite[] = [];
	const plan = buildPlan({
		source: source.startsWith('http') ? 'drupflare' : 'vps',
		discovered,
		tenant: loaded.config.tenants[0]?.name ?? 'default',
		node: loaded.config.cluster?.node.id ?? 'local',
		capacity: answer,
		currentSites: loaded.config.tenants.reduce((n, t) => n + t.sites.length, 0)
	});
	emit(ctx, globals, plan, () =>
		[
			`source: ${plan.source}`,
			`destination: ${plan.destination.node}, bound by ${plan.destination.bindingTerm}`,
			'',
			'will not carry:',
			...plan.notCarried.map((entry) => `  ${entry}`),
			'',
			discovered.length === 0
				? 'no sites were surveyed; run `bastion migrate survey <source>` first'
				: table(
						['site', 'size', 'fits'],
						plan.sites.map((site) => [
							site.site.host,
							String(site.site.sizeBytes),
							site.fits ? 'yes' : (site.blockedBy ?? 'no')
						])
					)
		].join('\n')
	);
}
