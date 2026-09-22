import type {
	BastionConfig,
	Context,
	SiteConfig,
	TemplatePlan,
	TenantConfig
} from '@drupflare/bastion';
import {
	BY_CODE,
	BackupEngine,
	BastionError,
	DEFAULT_CAPABILITIES,
	RUNG_ACTION,
	TRIPWIRES,
	TokenStore,
	admitSite,
	backupTarget,
	buildObjects,
	capacity,
	defaultCostModel,
	firecrackerHypervisor,
	pullTemplate,
	readHost,
	refusals,
	retain,
	writeConfig
} from '@drupflare/bastion';
import { kv, table, yesNo } from '../format';
import { emit, load, type Globals } from '../state';

function write(ctx: Context, path: string | null, config: BastionConfig): string {
	return writeConfig(ctx, path ?? `${ctx.cwd}/bastion.yml`, config);
}

export function runTenantList(ctx: Context, globals: Globals): void {
	const loaded = load(ctx, globals);
	emit(ctx, globals, { tenants: loaded.config.tenants }, () =>
		loaded.config.tenants.length === 0
			? 'no tenants are configured'
			: table(
					['tenant', 'sites', 'cpu', 'memory', 'max sites'],
					loaded.config.tenants.map((tenant) => [
						tenant.name,
						String(tenant.sites.length),
						String(tenant.limits?.cpu ?? 'max'),
						String(tenant.limits?.memory ?? 'max'),
						String(tenant.limits?.maxSites ?? '-')
					])
				)
	);
}

export function runTenantShow(ctx: Context, globals: Globals, name: string): void {
	const loaded = load(ctx, globals);
	const tenant = loaded.config.tenants.find((entry) => entry.name === name);
	if (tenant === undefined) throw new BastionError('usage', `there is no tenant called ${name}`);
	const capabilities = { ...DEFAULT_CAPABILITIES, ...(tenant.capabilities ?? {}) };

	// every capability names WHERE it is enforced; one that is only a var says so rather than
	// implying containment it does not have
	const rows: [string, string, string][] = [
		['codegen', yesNo(capabilities.codegen), 'capnp: unsafeEval is not emitted -- enforced'],
		['workerLoader', yesNo(capabilities.workerLoader), 'capnp -- enforced'],
		[
			'diagnosticRoutes',
			yesNo(capabilities.diagnosticRoutes),
			'front door, per route -- enforced'
		],
		[
			'extensions',
			capabilities.extensions.join(', ') || '(none)',
			'operator catalogue -- enforced at bake'
		],
		[
			'adminPhpConsole',
			yesNo(capabilities.adminPhpConsole),
			'site var, KV-overridable -- DECLARED, not enforced'
		]
	];

	emit(ctx, globals, { tenant, capabilities }, () =>
		[
			kv([
				['tenant', tenant.name],
				['sites', String(tenant.sites.length)],
				['egress', (tenant.egress?.allow ?? []).join(', ') || '(everything denied)']
			]),
			'',
			table(
				['capability', 'value', 'enforcement point'],
				rows.map((r) => [...r])
			)
		].join('\n')
	);
}

export function runTenantAdd(
	ctx: Context,
	globals: Globals & { cpu?: string; memory?: string; maxSites?: string },
	name: string
): void {
	const loaded = load(ctx, globals);
	if (loaded.config.tenants.some((tenant) => tenant.name === name)) {
		throw new BastionError('usage', `${name} already exists`);
	}
	const tenant: TenantConfig = {
		name,
		sites: [],
		limits: {
			...(globals.cpu === undefined ? {} : { cpu: globals.cpu }),
			...(globals.memory === undefined ? {} : { memory: Number(globals.memory) }),
			...(globals.maxSites === undefined ? {} : { maxSites: Number(globals.maxSites) })
		}
	};
	const config = { ...loaded.config, tenants: [...loaded.config.tenants, tenant] };
	const path = write(ctx, loaded.path, config);
	emit(ctx, globals, { tenant, wrote: path }, () => `added tenant ${name} to ${path}`);
}

export function runTenantRm(
	ctx: Context,
	globals: Globals & { purge?: boolean },
	name: string
): void {
	const loaded = load(ctx, globals);
	const tenant = loaded.config.tenants.find((entry) => entry.name === name);
	if (tenant === undefined) throw new BastionError('usage', `there is no tenant called ${name}`);
	if (globals.purge === true && globals.yes !== true) {
		throw new BastionError(
			'usage',
			`--purge deletes ${tenant.sites.length} sites' state and cannot be undone`,
			{ next: 'bastion backup verify' }
		);
	}
	const config = {
		...loaded.config,
		tenants: loaded.config.tenants.filter((entry) => entry.name !== name)
	};
	const path = write(ctx, loaded.path, config);
	emit(
		ctx,
		globals,
		{ removed: name, purged: globals.purge === true, wrote: path },
		() => `removed tenant ${name} from ${path}`
	);
}

export function runSiteList(ctx: Context, globals: Globals): void {
	const loaded = load(ctx, globals);
	const sites = loaded.config.tenants.flatMap((tenant) =>
		tenant.sites.map((site) => ({ ...site, tenant: tenant.name }))
	);
	emit(ctx, globals, { sites }, () =>
		sites.length === 0
			? 'no sites are configured'
			: table(
					['site', 'tenant', 'primary', 'replicas'],
					sites.map((site) => [
						site.host,
						site.tenant,
						site.primary ?? '(local)',
						(site.replicas ?? []).join(', ') || '-'
					])
				)
	);
}

export async function runSiteAdd(
	ctx: Context,
	globals: Globals & { tenant?: string; bundle?: string; template?: string; probe?: string },
	host: string
): Promise<void> {
	const loaded = load(ctx, globals);
	const name = globals.tenant ?? loaded.config.tenants[0]?.name;
	const tenant = loaded.config.tenants.find((entry) => entry.name === name);
	if (tenant === undefined) {
		throw new BastionError('usage', 'name a tenant with --tenant', {
			next: 'bastion tenant list'
		});
	}
	if (loaded.config.tenants.some((t) => t.sites.some((s) => s.host === host))) {
		throw new BastionError('usage', `${host} is already configured`);
	}

	const answer = capacity(readHost(ctx, loaded.state), defaultCostModel(loaded.config.mode), {
		residency: loaded.config.runtime.residency,
		tenants: Math.max(1, loaded.config.tenants.length)
	});
	const admitted = admitSite(tenant.sites.length, answer, tenant.limits?.maxSites);
	if (admitted.warning !== null) ctx.io.err(admitted.warning);

	// a template states its own bindings, so the site inherits them rather than the drupflare shape
	let plan: TemplatePlan | null = null;
	if (globals.template !== undefined) {
		plan = await pullTemplate(ctx, globals.template, {
			dest: `${loaded.config.state}/templates/${host}`
		});
	}
	const sibling = tenant.sites[0];
	const probe = globals.probe ?? (plan === null ? (sibling?.probe ?? 'drupflare') : undefined);

	const site: SiteConfig = {
		host,
		bundle: globals.bundle ?? sibling?.bundle ?? './payload.tar.gz',
		...(probe === undefined ? {} : { probe }),
		...(plan === null ? {} : { worker: plan.worker })
	};
	const config = {
		...loaded.config,
		tenants: loaded.config.tenants.map((entry) =>
			entry.name === name ? { ...entry, sites: [...entry.sites, site] } : entry
		)
	};
	const path = write(ctx, loaded.path, config);

	// a binding that does not carry is named at install time; finding out from a 500 in production
	// is the failure this whole reader exists to prevent
	const dropped = plan === null ? [] : refusals(plan);
	for (const finding of dropped) {
		ctx.io.err(`not carried: ${finding.name} (${finding.type}) -- ${finding.reason}`);
	}
	if (plan !== null && plan.crons.length > 0) {
		ctx.io.err(
			`not scheduled: ${plan.crons.join(', ')} -- bastion has no cron scheduler, so these never fire`
		);
	}

	emit(
		ctx,
		globals,
		{
			site,
			tenant: name,
			warning: admitted.warning,
			wrote: path,
			template:
				plan === null ? null : { name: plan.name, crons: plan.crons, refused: dropped }
		},
		() =>
			`added ${host} to tenant ${name} in ${path}` +
			(dropped.length === 0 ? '' : `\n${dropped.length} binding(s) not carried`)
	);
}

/**
 * Reads a template and reports what would carry, changing nothing.
 *
 * The dry run for `site add --template`: an operator evaluating whether a Worker can move here
 * should get the answer without writing a site into the configuration first.
 */
export async function runSiteTemplate(
	ctx: Context,
	globals: Globals,
	source: string
): Promise<number> {
	const loaded = load(ctx, globals);
	const plan = await pullTemplate(ctx, source, {
		dest: `${loaded.config.state}/templates/.inspect`
	});
	const dropped = refusals(plan);
	emit(ctx, globals, { source, ...plan }, () =>
		[
			kv([
				['template', plan.name ?? '(unnamed)'],
				['entrypoint', plan.worker.main ?? '(inferred from the bundle)'],
				['durable object', plan.worker.durableObjectClass ?? '(none)'],
				['assets', plan.worker.assets ?? '(none)'],
				['kv', plan.worker.kv?.join(', ') || '(none)'],
				['r2', plan.worker.r2?.join(', ') || '(none)'],
				['queues', plan.worker.queues?.join(', ') || '(none)'],
				['crons', plan.crons.join(', ') || '(none)']
			]),
			'',
			dropped.length === 0
				? 'every binding carries'
				: table(
						['binding', 'declared as', 'why it does not carry'],
						dropped.map((f) => [f.name, f.type, f.reason])
					)
		].join('\n')
	);
	return dropped.length === 0 ? 0 : 3;
}

export function runSiteRm(ctx: Context, globals: Globals, host: string): void {
	const loaded = load(ctx, globals);
	const owner = loaded.config.tenants.find((tenant) =>
		tenant.sites.some((site) => site.host === host)
	);
	// a removal that reports success for a host nothing holds is how a typo reads as done. It
	// also used to filter EVERY tenant rather than the one that owns the site
	if (owner === undefined) {
		throw new BastionError('usage', `no tenant holds ${host}`, { next: 'bastion site list' });
	}
	const config = {
		...loaded.config,
		tenants: loaded.config.tenants.map((tenant) =>
			tenant.name === owner.name
				? { ...tenant, sites: tenant.sites.filter((site) => site.host !== host) }
				: tenant
		)
	};
	const path = write(ctx, loaded.path, config);
	ctx.io.err(
		`the certificate for ${host} is left in place; remove it with \`bastion cert list\` if it ` +
			'is no longer wanted'
	);
	emit(
		ctx,
		globals,
		{ removed: host, tenant: owner.name, wrote: path },
		() => `removed ${host} from tenant ${owner.name} in ${path}`
	);
}

export async function runBackupList(ctx: Context, globals: Globals): Promise<void> {
	const loaded = load(ctx, globals);
	const store = buildObjects(ctx, backupTarget(loaded.config));
	const engine = new BackupEngine(ctx, store);
	const sites = loaded.config.tenants.flatMap((tenant) => tenant.sites.map((site) => site.host));
	const rows: { site: string; version: number; takenAt: number; bytes: number }[] = [];
	for (const site of sites) {
		for (const manifest of await engine.versions(site)) {
			rows.push({
				site,
				version: manifest.version,
				takenAt: manifest.takenAt,
				bytes: manifest.bytes
			});
		}
	}
	emit(ctx, globals, { backups: rows }, () =>
		rows.length === 0
			? 'no backups have been taken'
			: table(
					['site', 'version', 'taken', 'bytes'],
					rows.map((row) => [
						row.site,
						String(row.version),
						new Date(row.takenAt).toISOString(),
						String(row.bytes)
					])
				)
	);
}

export async function runBackupVerify(
	ctx: Context,
	globals: Globals,
	site: string
): Promise<number> {
	const loaded = load(ctx, globals);
	const store = buildObjects(ctx, backupTarget(loaded.config));
	const engine = new BackupEngine(ctx, store);
	const result = await engine.verify(site);
	emit(ctx, globals, { site, ...result }, () =>
		result.ok
			? `every frame of the newest backup of ${site} is present and hashes correctly`
			: `${result.missing.length} frames are missing or wrong`
	);
	return result.ok ? 0 : 3;
}

export async function runBackupPrune(ctx: Context, globals: Globals): Promise<void> {
	const loaded = load(ctx, globals);
	const store = buildObjects(ctx, backupTarget(loaded.config));
	const engine = new BackupEngine(ctx, store);
	const sites = loaded.config.tenants.flatMap((tenant) => tenant.sites.map((site) => site.host));
	const removed: Record<string, number[]> = {};
	for (const site of sites) {
		const keep = retain(await engine.versions(site));
		if (globals.yes === true) removed[site] = (await engine.prune(site, keep)).removedVersions;
		else
			removed[site] = (await engine.versions(site))
				.filter((manifest) => !keep.includes(manifest.version))
				.map((manifest) => manifest.version);
	}
	emit(ctx, globals, { removed, applied: globals.yes === true }, () =>
		globals.yes === true
			? `pruned ${Object.values(removed).flat().length} versions`
			: `${Object.values(removed).flat().length} versions would be pruned; pass --yes`
	);
}

export function runRepair(
	ctx: Context,
	globals: Globals & { rung?: string },
	code: string
): number {
	const tripwire = BY_CODE[code];
	if (tripwire === undefined) {
		throw new BastionError('usage', `${code} is not a tripwire`, { next: 'bastion diagnose' });
	}
	const rung = (globals.rung ?? tripwire.repair) as keyof typeof RUNG_ACTION | null;
	if (rung === null) {
		emit(
			ctx,
			globals,
			{ code, rung: null, button: tripwire.button },
			() => `${code} has no automatic repair; run ${tripwire.button}`
		);
		return 3;
	}
	emit(ctx, globals, { code, rung, action: RUNG_ACTION[rung] }, () =>
		kv([
			['code', code],
			['rung', rung],
			['would', RUNG_ACTION[rung] ?? ''],
			['undo', tripwire.button]
		])
	);
	return 0;
}

export function runQuarantineList(ctx: Context, globals: Globals): void {
	emit(ctx, globals, { quarantined: [] }, () => 'nothing is quarantined');
}

export function runVmList(ctx: Context, globals: Globals): number {
	const loaded = load(ctx, globals);
	if (loaded.config.mode !== 'isolated') {
		ctx.io.err(
			`there are no guests in \`${loaded.config.mode}\`; guests exist only in \`isolated\``
		);
		return 2;
	}
	const hypervisor = firecrackerHypervisor();
	const reason = hypervisor.unavailableReason(ctx);
	if (reason !== null) {
		ctx.io.err(reason);
		return 3;
	}
	const guests = hypervisor.list();
	emit(ctx, globals, { guests }, () =>
		guests.length === 0
			? 'no guests are running'
			: table(
					['tenant', 'state', 'pid'],
					guests.map((guest) => [guest.tenant, guest.state, String(guest.pid ?? '-')])
				)
	);
	return 0;
}

export function runTokenCreate(
	ctx: Context,
	globals: Globals & { tenant?: string; role?: string },
	name = 'token'
): void {
	const tokens = new TokenStore(ctx);
	const role = (globals.role ?? 'tenant-viewer') as 'tenant-admin' | 'tenant-viewer';
	const { token, secret } = tokens.create(name, role, globals.tenant ?? null);
	// the secret is printed once and never stored; a --json payload carries the id, not the secret
	if (globals.json === true) {
		ctx.io.out(JSON.stringify({ id: token.id, role: token.role, tenant: token.tenant }));
		ctx.io.err(secret);
		return;
	}
	ctx.io.out(
		kv([
			['id', token.id],
			['role', token.role],
			['tenant', token.tenant ?? '(none)']
		])
	);
	ctx.io.out('');
	ctx.io.out(`${secret}`);
	ctx.io.out('that is the only time the secret is shown');
}

export function runTripwires(ctx: Context, globals: Globals): void {
	emit(ctx, globals, { tripwires: TRIPWIRES }, () =>
		table(
			['code', 'severity', 'means'],
			TRIPWIRES.map((t) => [t.code, t.severity, t.means])
		)
	);
}
