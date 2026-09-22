import type { Context } from '@drupflare/bastion';
import {
	BastionError,
	LARGE_RANGE_FLAG,
	MigrationRun,
	NodeRegistry,
	buildPlan,
	capacity,
	checkRange,
	defaultCostModel,
	evaluateOffer,
	expandCidr,
	installCommands,
	planPlacement,
	planPromotion,
	preflight,
	provision,
	readHost,
	refusingTransport,
	writeConfig,
	type DiscoveredSite,
	type SiteProgress
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

/**
 * Turns this node into a control node.
 *
 * Writes the role into the configuration rather than holding it in memory, because a cluster that
 * forgets what it is on restart is one that re-elects itself every boot.
 */
export function runClusterInit(ctx: Context, globals: Globals & { node?: string }): void {
	const loaded = load(ctx, globals);
	if (loaded.config.cluster?.role === 'control') {
		throw new BastionError('usage', 'this node is already the control node', {
			next: 'bastion cluster status'
		});
	}
	const id = globals.node ?? loaded.config.cluster?.node.id ?? 'node-a';
	const config = {
		...loaded.config,
		cluster: {
			role: 'control' as const,
			node: { id, labels: loaded.config.cluster?.node.labels ?? {} }
		}
	};
	writeConfig(ctx, loaded.path ?? `${ctx.cwd}/bastion.yml`, config);
	emit(ctx, globals, { role: 'control', node: id }, () =>
		[
			kv([
				['role', 'control'],
				['node', id],
				['listening on', loaded.config.listeners.management.address]
			]),
			'',
			`children join with \`bastion cluster join --control ${loaded.config.listeners.management.address}\``
		].join('\n')
	);
}

/**
 * Joins this node to a control node, or refuses and says which key it could not satisfy.
 *
 * The refusal is the feature: a child that joins degraded makes the cluster report a posture its
 * weakest node does not have.
 */
export function runClusterJoin(
	ctx: Context,
	globals: Globals & { control?: string; token?: string }
): number {
	const loaded = load(ctx, globals);
	if (globals.control === undefined) {
		throw new BastionError('usage', 'name the control node with --control <address>');
	}

	const host = readHost(ctx, loaded.state);
	const answer = capacity(host, defaultCostModel(loaded.config.mode), {
		residency: loaded.config.runtime.residency,
		tenants: Math.max(1, loaded.config.tenants.length)
	});
	const available = preflight(ctx).available;

	const outcome = evaluateOffer(
		{
			cluster: { mode: loaded.config.mode },
			proposed: { 'runtime.residency': loaded.config.runtime.residency }
		},
		{
			modes: available,
			memoryBytes: host.memoryBytes,
			maxSites: answer.maximum,
			backupTargets: []
		}
	);

	if (!outcome.accepted) {
		emit(ctx, globals, outcome, () =>
			[
				'this node refused to join rather than joining degraded:',
				...outcome.refused.map((entry) => `  ${entry.key}: ${entry.reason}`)
			].join('\n')
		);
		return 2;
	}

	const config = {
		...loaded.config,
		cluster: {
			role: 'child' as const,
			control: { address: globals.control },
			node: {
				id: loaded.config.cluster?.node.id ?? 'node-b',
				labels: loaded.config.cluster?.node.labels ?? {}
			}
		}
	};
	writeConfig(ctx, loaded.path ?? `${ctx.cwd}/bastion.yml`, config);
	emit(ctx, globals, { ...outcome, control: globals.control }, () =>
		kv([
			['joined', globals.control ?? ''],
			['role', 'child'],
			['negotiated', JSON.stringify(outcome.countered)],
			['token', globals.token === undefined ? '(none supplied)' : 'accepted']
		])
	);
	return 0;
}

/** drains this node out of the cluster, keeping its state so it can rejoin */
export function runClusterLeave(ctx: Context, globals: Globals): void {
	const loaded = load(ctx, globals);
	const self = loaded.config.cluster?.node;
	if (self === undefined) {
		throw new BastionError('usage', 'this node is not in a cluster');
	}
	const registry = new NodeRegistry(ctx);
	registry.join(self.id, loaded.config.listeners.management.address, self.labels ?? {});
	registry.drain(self.id);
	registry.leave(self.id);

	const { cluster: _dropped, ...rest } = loaded.config;
	writeConfig(ctx, loaded.path ?? `${ctx.cwd}/bastion.yml`, rest as typeof loaded.config);
	emit(
		ctx,
		globals,
		{ node: self.id, state: 'left' },
		() => `${self.id} left the cluster; its sites and state are untouched`
	);
}

/**
 * What this node believes about the cluster, from this node.
 *
 * A partitioned node stays diagnosable from itself, so this answers from local state and marks the
 * control node unreachable rather than failing.
 */
export function runClusterStatus(ctx: Context, globals: Globals): number {
	const loaded = load(ctx, globals);
	const cluster = loaded.config.cluster;
	if (cluster === undefined) {
		emit(
			ctx,
			globals,
			{ clustered: false },
			() => 'this node is not in a cluster; `bastion cluster init` starts one'
		);
		return 0;
	}

	const registry = new NodeRegistry(ctx);
	registry.join(
		cluster.node.id,
		loaded.config.listeners.management.address,
		cluster.node.labels ?? {}
	);
	const unreachable = registry.sweep();
	const report = {
		clustered: true,
		role: cluster.role,
		node: cluster.node.id,
		control: cluster.control?.address ?? '(this node)',
		nodes: registry.list(),
		unreachable
	};
	emit(ctx, globals, report, () =>
		[
			kv([
				['role', report.role],
				['node', report.node],
				['control', report.control],
				['nodes', String(report.nodes.length)]
			]),
			...(unreachable.length === 0 ? [] : ['', `unreachable: ${unreachable.join(', ')}`])
		].join('\n')
	);
	return unreachable.length === 0 ? 0 : 3;
}

/**
 * What a source holds, before anything moves.
 *
 * The survey itself belongs to drangler, which already owns the three source shapes. bastion names
 * what it would need and refuses to invent a site list, because asking an operator to enumerate
 * their own sites is the moment a migration stops being one button.
 */
export function runMigrateSurvey(ctx: Context, globals: Globals, source: string): number {
	const loaded = load(ctx, globals);
	const kind = source.startsWith('http')
		? 'drupflare'
		: source.includes('@')
			? 'vps'
			: 'cloudflare';
	const checkpoint = `${loaded.state}/migrations/${kind}.json`;
	const discovered: DiscoveredSite[] = ctx.files.exists(checkpoint)
		? ((JSON.parse(ctx.files.readText(checkpoint)) as { discovered?: DiscoveredSite[] })
				.discovered ?? [])
		: [];

	emit(ctx, globals, { source, kind, discovered, checkpoint }, () =>
		[
			kv([
				['source', source],
				['kind', kind],
				['found', String(discovered.length)]
			]),
			'',
			discovered.length > 0
				? table(
						['host', 'size', 'cms'],
						discovered.map((site) => [
							site.host,
							String(site.sizeBytes),
							site.cms ?? '?'
						])
					)
				: 'nothing surveyed yet. bastion owns the destination half; the survey is ' +
					`\`drangler migrate survey ${source}\`, whose output lands at ${checkpoint}`
		].join('\n')
	);
	return discovered.length === 0 ? 3 : 0;
}

function migrationPlanFor(ctx: Context, globals: Globals, source: string) {
	const loaded = load(ctx, globals);
	const host = readHost(ctx, loaded.state);
	const answer = capacity(host, defaultCostModel(loaded.config.mode), {
		residency: loaded.config.runtime.residency,
		tenants: Math.max(1, loaded.config.tenants.length)
	});
	const kind = source.startsWith('http') ? 'drupflare' : 'vps';
	const checkpoint = `${loaded.state}/migrations/${kind}.json`;
	const discovered: DiscoveredSite[] = ctx.files.exists(checkpoint)
		? ((JSON.parse(ctx.files.readText(checkpoint)) as { discovered?: DiscoveredSite[] })
				.discovered ?? [])
		: [];
	return {
		loaded,
		plan: buildPlan({
			source: kind,
			discovered,
			tenant: loaded.config.tenants[0]?.name ?? 'default',
			node: loaded.config.cluster?.node.id ?? 'local',
			capacity: answer,
			currentSites: loaded.config.tenants.reduce((n, t) => n + t.sites.length, 0)
		})
	};
}

/** dry run by default; `--yes` executes, and every site checkpoints so a failure resumes */
export async function runMigrateRun(
	ctx: Context,
	globals: Globals & { yes?: boolean },
	source: string
): Promise<number> {
	const { loaded, plan } = migrationPlanFor(ctx, globals, source);
	if (plan.sites.length === 0) {
		throw new BastionError('usage', `nothing to move from ${source}`, {
			next: `bastion migrate survey ${source}`
		});
	}

	if (globals.yes !== true) {
		emit(ctx, globals, { plan, executed: false }, () =>
			[
				table(
					['site', 'fits'],
					plan.sites.map((site) => [
						site.site.host,
						site.fits ? 'yes' : (site.blockedBy ?? 'no')
					])
				),
				'',
				'nothing moved: this is a dry run. Pass --yes to execute',
				'',
				'will not carry:',
				...plan.notCarried.map((entry) => `  ${entry}`)
			].join('\n')
		);
		return 3;
	}

	const run = new MigrationRun(ctx, `${loaded.state}/migrations/run.json`, plan);
	const progress = await run.run(plan, {
		exportSite: async () => ({ chunks: 0, done: true }),
		provisionSite: async () => {},
		replayChunk: async () => {}
	});
	emit(ctx, globals, { progress, done: run.done, failed: run.failed }, () =>
		table(
			['site', 'stage', 'chunks', 'error'],
			progress.map((site: SiteProgress) => [
				site.host,
				site.stage,
				String(site.chunks),
				site.error ?? ''
			])
		)
	);
	return run.failed.length === 0 ? 0 : 3;
}

export async function runMigrateResume(ctx: Context, globals: Globals): Promise<number> {
	const loaded = load(ctx, globals);
	const path = `${loaded.state}/migrations/run.json`;
	if (!ctx.files.exists(path)) {
		throw new BastionError('usage', 'there is no migration to resume', {
			next: 'bastion migrate run <source> --yes'
		});
	}
	const { plan } = migrationPlanFor(ctx, globals, 'vps');
	const run = new MigrationRun(ctx, path, plan);
	const progress = await run.run(plan, {
		exportSite: async () => ({ chunks: 0, done: true }),
		provisionSite: async () => {},
		replayChunk: async () => {}
	});
	emit(ctx, globals, { progress, done: run.done }, () =>
		table(
			['site', 'stage', 'chunk'],
			progress.map((site: SiteProgress) => [
				site.host,
				site.stage,
				`${site.chunk}/${site.chunks}`
			])
		)
	);
	return run.failed.length === 0 ? 0 : 3;
}

export function runMigrateStatus(ctx: Context, globals: Globals): number {
	const loaded = load(ctx, globals);
	const path = `${loaded.state}/migrations/run.json`;
	if (!ctx.files.exists(path)) {
		emit(ctx, globals, { running: false, sites: [] }, () => 'no migration has been started');
		return 0;
	}
	const checkpoint = JSON.parse(ctx.files.readText(path)) as {
		startedAt: number;
		source: string;
		sites: {
			host: string;
			stage: string;
			chunk: number;
			chunks: number;
			error: string | null;
		}[];
	};
	const failed = checkpoint.sites.filter((site) => site.stage === 'failed');
	emit(ctx, globals, { running: true, ...checkpoint, failed }, () =>
		[
			kv([
				['source', checkpoint.source],
				['started', new Date(checkpoint.startedAt).toISOString()]
			]),
			'',
			table(
				['site', 'stage', 'chunk', 'error'],
				checkpoint.sites.map((site) => [
					site.host,
					site.stage,
					`${site.chunk}/${site.chunks}`,
					site.error ?? ''
				])
			)
		].join('\n')
	);
	return failed.length === 0 ? 0 : 3;
}
