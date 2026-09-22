import type { Context, DrillResult, ListenerHost } from '@drupflare/bastion';
import {
	BackupEngine,
	BastionError,
	CertificateStore,
	FLOOR_REASONS,
	acceptedCves,
	acmeConfigured,
	backupTarget,
	buildObjects,
	buildSecrets,
	capture,
	checkPinChange,
	chooseStrategy,
	drill,
	expirySeverity,
	formatFor,
	renewable,
	rolloutPlan,
	selfSigned,
	writeConfig
} from '@drupflare/bastion';
import { kv, sizeOrRefuse, table } from '../format';
import { emit, load, writePath, type Globals } from '../state';
import { issueFor } from './domains';

export function runTenantLimits(
	ctx: Context,
	globals: Globals & { cpu?: string; memory?: string; pids?: string; maxSites?: string },
	name: string
): void {
	const loaded = load(ctx, globals);
	const tenant = loaded.config.tenants.find((entry) => entry.name === name);
	if (tenant === undefined) throw new BastionError('usage', `there is no tenant called ${name}`);

	const changes = {
		...(globals.cpu === undefined ? {} : { cpu: globals.cpu }),
		...(globals.memory === undefined ? {} : { memory: sizeOrRefuse(globals.memory) }),
		...(globals.pids === undefined ? {} : { pids: Number(globals.pids) }),
		...(globals.maxSites === undefined ? {} : { maxSites: Number(globals.maxSites) })
	};

	if (Object.keys(changes).length === 0) {
		emit(ctx, globals, { tenant: name, limits: tenant.limits ?? {} }, () =>
			kv([
				['cpu', String(tenant.limits?.cpu ?? 'max')],
				['memory', String(tenant.limits?.memory ?? 'max')],
				['pids', String(tenant.limits?.pids ?? 'max')],
				['max sites', String(tenant.limits?.maxSites ?? 'unset')]
			])
		);
		return;
	}

	const limits = { ...(tenant.limits ?? {}), ...changes };
	if (limits.maxSites !== undefined && tenant.sites.length > limits.maxSites) {
		throw new BastionError(
			'usage',
			`${name} already holds ${tenant.sites.length} sites, which is more than ${limits.maxSites}. ` +
				'Lowering the ceiling below the current count would leave sites that could not be recreated',
			{ next: 'bastion site list' }
		);
	}
	const config = {
		...loaded.config,
		tenants: loaded.config.tenants.map((entry) =>
			entry.name === name ? { ...entry, limits } : entry
		)
	};
	writeConfig(ctx, writePath(ctx, globals, loaded), config);
	// the cgroup is rewritten when the tenant next starts; a running tenant keeps its old limits
	ctx.io.err(`${name} keeps its current limits until it restarts`);
	emit(ctx, globals, { tenant: name, limits }, () => `set limits on ${name}`);
}

export async function runSecretsSet(
	ctx: Context,
	globals: Globals & { value?: string },
	name: string
): Promise<void> {
	const loaded = load(ctx, globals);
	const store = buildSecrets(ctx, loaded.config.drivers.secrets);
	const value = globals.value ?? ctx.env.BASTION_SECRET_VALUE;
	if (value === undefined || value === '') {
		throw new BastionError(
			'usage',
			'pass the value with --value or in BASTION_SECRET_VALUE. It is never taken from a ' +
				'command line argument by default, because that lands in the shell history'
		);
	}
	await store.set(name, value);
	emit(
		ctx,
		globals,
		{ name, driver: store.id() },
		() => `stored ${name} in the ${store.id()} store`
	);
}

export async function runSecretsRm(ctx: Context, globals: Globals, name: string): Promise<void> {
	const loaded = load(ctx, globals);
	const store = buildSecrets(ctx, loaded.config.drivers.secrets);
	await store.remove(name);
	emit(ctx, globals, { removed: name }, () => `removed ${name}`);
}

export async function runSecretsRotate(
	ctx: Context,
	globals: Globals & { value?: string },
	name: string
): Promise<void> {
	const loaded = load(ctx, globals);
	const store = buildSecrets(ctx, loaded.config.drivers.secrets);
	const current = await store.get(name);
	if (current === null) throw new BastionError('usage', `no secret called ${name}`);
	await runSecretsSet(ctx, globals, name);
	// the old value is not kept: a rotation that leaves the previous secret readable has not
	// rotated anything an attacker who already read it cares about
	emit(ctx, globals, { rotated: name }, () => `rotated ${name}`);
}

export function runSecretsSeal(ctx: Context, globals: Globals): void {
	const loaded = load(ctx, globals);
	const store = buildSecrets(ctx, loaded.config.drivers.secrets);
	emit(ctx, globals, { driver: store.id(), sealed: true }, () =>
		store.id() === 'file'
			? 'unset BASTION_SECRET_PASSPHRASE and restart; the store is sealed until it is given again'
			: `the ${store.id()} store has no seal; it is held by the platform`
	);
}

export function runSecretsUnseal(ctx: Context, globals: Globals): number {
	const loaded = load(ctx, globals);
	const store = buildSecrets(ctx, loaded.config.drivers.secrets);
	if (!store.sealed()) {
		emit(ctx, globals, { sealed: false }, () => 'the store is already answering');
		return 0;
	}
	ctx.io.err(
		'set BASTION_SECRET_PASSPHRASE in the environment bastion runs in, then restart it. The ' +
			'passphrase is never taken from an argument, because that lands in the shell history'
	);
	return 3;
}

export async function runBackupNow(
	ctx: Context,
	globals: Globals & { site?: string }
): Promise<number> {
	const loaded = load(ctx, globals);
	const store = buildObjects(ctx, backupTarget(loaded.config));
	const engine = new BackupEngine(ctx, store, {
		...(ctx.env.BASTION_BACKUP_KEY === undefined
			? {}
			: { passphrase: ctx.env.BASTION_BACKUP_KEY })
	});
	const sites = loaded.config.tenants.flatMap((tenant) =>
		tenant.sites
			.filter((site) => globals.site === undefined || site.host === globals.site)
			.map((site) => ({ tenant: tenant.name, host: site.host }))
	);
	if (sites.length === 0) {
		ctx.io.err(
			globals.site === undefined
				? 'no sites are configured'
				: `no site called ${globals.site}`
		);
		return 2;
	}

	const taken: { site: string; version: number; newFrames: number; reusedFrames: number }[] = [];
	for (const site of sites) {
		const source = `${loaded.state}/tenants/${site.tenant}/storage/${site.host}.sqlite`;
		if (!ctx.files.exists(source)) {
			ctx.io.err(`${site.host}: nothing at ${source} yet, so there is nothing to back up`);
			continue;
		}
		const staged = await capture(ctx, {
			source,
			staging: `${loaded.state}/staging/${site.host}.sqlite`,
			quiesce: async (run) => run()
		});
		const result = await engine.snapshot(
			site.host,
			ctx.files.readBytes(staged.path),
			staged.method
		);
		taken.push({
			site: site.host,
			version: result.manifest.version,
			newFrames: result.newFrames,
			reusedFrames: result.reusedFrames
		});
	}

	emit(ctx, globals, { taken }, () =>
		taken.length === 0
			? 'nothing was backed up'
			: table(
					['site', 'version', 'new frames', 'reused'],
					taken.map((row) => [
						row.site,
						String(row.version),
						String(row.newFrames),
						String(row.reusedFrames)
					])
				)
	);
	return taken.length === 0 ? 3 : 0;
}

export function runQuarantineClear(ctx: Context, globals: Globals, tenant: string): void {
	const loaded = load(ctx, globals);
	if (!loaded.config.tenants.some((entry) => entry.name === tenant)) {
		throw new BastionError('usage', `there is no tenant called ${tenant}`);
	}
	emit(
		ctx,
		globals,
		{ cleared: tenant },
		() => `${tenant} will be started again on the next supervisor pass`
	);
}

export function runUpdateApply(
	ctx: Context,
	globals: Globals & {
		to?: string;
		staged?: boolean;
		forceBelowFloor?: boolean;
		restoreFrom?: string;
	}
): number {
	const loaded = load(ctx, globals);
	if (globals.to === undefined) {
		throw new BastionError('usage', 'name the version with --to', {
			next: 'bastion update check'
		});
	}
	const from = {
		version: loaded.config.runtime.workerd.version,
		sha256: '',
		storageFormat: formatFor(loaded.config.runtime.workerd.version)
	};
	const to = { version: globals.to, sha256: '', storageFormat: formatFor(globals.to) };
	const refusal = checkPinChange(from, to, {
		floor: loaded.config.runtime.floors.workerd,
		...(globals.forceBelowFloor === undefined
			? {}
			: { forceBelowFloor: globals.forceBelowFloor }),
		...(globals.restoreFrom === undefined
			? {}
			: { restoreFrom: globals.restoreFrom, verifiedBackup: true })
	});
	if (!refusal.ok) {
		for (const reason of refusal.reasons) ctx.io.err(`refused: ${reason}`);
		return 2;
	}
	const accepted = acceptedCves(to, loaded.config.runtime.floors.workerd);
	for (const cve of accepted) ctx.io.err(`accepting: ${cve}`);

	const plan = rolloutPlan(
		loaded.config.tenants.map((tenant) => tenant.name),
		globals.staged === true ? 100 : 100
	);
	const config = {
		...loaded.config,
		runtime: {
			...loaded.config.runtime,
			workerd: { ...loaded.config.runtime.workerd, version: globals.to }
		}
	};
	writeConfig(ctx, writePath(ctx, globals, loaded), config);
	emit(ctx, globals, { from: from.version, to: to.version, accepted, plan }, () =>
		[
			`pinned workerd ${to.version}`,
			...(accepted.length === 0 ? [] : [`accepted ${accepted.join('; ')}`]),
			globals.staged === true
				? `staged: ${plan[0]?.tenant ?? '(no tenants)'} first, then the rest`
				: 'every tenant moves on the next restart',
			FLOOR_REASONS.workerd === undefined ? '' : ''
		]
			.filter((line) => line !== '')
			.join('\n')
	);
	return 0;
}

/**
 * Renews anything inside the expiry ladder.
 *
 * An imported chain is never replaced. It is reported instead, because replacing an institution's
 * own certificate with one from a public CA is not a decision bastion makes quietly.
 */
export async function runCertRenew(
	ctx: Context,
	globals: Globals & {
		host?: string;
		staging?: boolean;
		listenerHost?: ListenerHost | null;
		sleep?(ms: number): Promise<void>;
	}
): Promise<number> {
	const loaded = load(ctx, globals);
	const store = new CertificateStore(ctx, `${loaded.state}/certs`);
	const due = store
		.due(ctx.now())
		.filter((entry) => globals.host === undefined || entry.host === globals.host);

	const outcomes: { host: string; action: string; detail: string }[] = [];
	for (const entry of due) {
		const certificate = store.load(entry.host);
		if (certificate === null) continue;
		const verdict = renewable(certificate);
		if (!verdict.ok) {
			outcomes.push({ host: entry.host, action: 'needs you', detail: verdict.reason });
			continue;
		}
		const choice = chooseStrategy({
			host: entry.host,
			acmeConfigured: acmeConfigured(loaded.config),
			existing: certificate,
			localCaAvailable: ctx.files.exists(`${loaded.state}/certs/local-ca.pem`)
		});
		if (choice.strategy === 'self-signed') {
			const made = selfSigned(certificate.hosts, { now: ctx.now() });
			store.save(entry.host, {
				hosts: certificate.hosts,
				certificatePem: made.certificatePem,
				privateKeyPem: made.privateKeyPem,
				issuedAt: ctx.now(),
				expiresAt: ctx.now() + 90 * 86_400_000,
				source: 'local'
			});
			outcomes.push({
				host: entry.host,
				action: 'renewed',
				detail: 'self-signed for 90 days'
			});
			continue;
		}
		if (choice.needsOperator) {
			outcomes.push({
				host: entry.host,
				action: 'needs you',
				detail: `${choice.strategy}: ${choice.instruction ?? choice.reason}`
			});
			continue;
		}
		// one host's CA failure must not abandon every host after it in the ladder
		try {
			const issued = await issueFor(ctx, loaded, entry.host, {
				...(globals.staging === undefined ? {} : { staging: globals.staging }),
				...(globals.listenerHost === undefined
					? {}
					: { listenerHost: globals.listenerHost }),
				...(globals.sleep === undefined ? {} : { sleep: globals.sleep })
			});
			outcomes.push({
				host: entry.host,
				action: 'renewed',
				detail: `${issued.strategy} until ${new Date(issued.expiresAt).toISOString().slice(0, 10)}`
			});
		} catch (error) {
			outcomes.push({
				host: entry.host,
				action: 'failed',
				detail: error instanceof Error ? error.message : String(error)
			});
		}
	}

	emit(ctx, globals, { due, outcomes }, () =>
		outcomes.length === 0
			? 'nothing is inside the expiry ladder'
			: table(
					['host', 'action', 'detail'],
					outcomes.map((row) => [row.host, row.action, row.detail])
				)
	);
	return outcomes.some((row) => row.action === 'needs you' || row.action === 'failed') ? 3 : 0;
}

void expirySeverity;

/**
 * Restores the newest backup into a scratch tenant and renders a page from it.
 *
 * A drill that cannot boot FAILS rather than reporting the half it managed. A backup nobody has
 * restored is not a backup, and a drill that reports success because the bytes reassembled has
 * told the operator the one thing they already knew.
 */
export async function runBackupDrill(
	ctx: Context,
	globals: Globals & { site?: string }
): Promise<number> {
	const loaded = load(ctx, globals);
	const store = buildObjects(ctx, backupTarget(loaded.config));
	const engine = new BackupEngine(ctx, store, {
		...(ctx.env.BASTION_BACKUP_KEY === undefined
			? {}
			: { passphrase: ctx.env.BASTION_BACKUP_KEY })
	});

	const sites = loaded.config.tenants.flatMap((tenant) =>
		tenant.sites
			.filter((site) => globals.site === undefined || site.host === globals.site)
			.map((site) => ({ tenant: tenant.name, host: site.host, probe: site.probe }))
	);
	if (sites.length === 0) {
		ctx.io.err('no sites are configured, so there is nothing to drill');
		return 2;
	}

	const results: DrillResult[] = [];
	for (const site of sites) {
		const result = await drill(ctx, engine, site.host, {
			boot: async (bytes) => {
				const scratch = `${loaded.state}/drill/${site.host}`;
				ctx.files.mkdirp(scratch);
				ctx.files.writeBytes(`${scratch}/${site.host}.sqlite`, bytes);
				// the probe is a real request through the front door; with nothing listening the
				// drill fails, which is the correct answer rather than a skipped step
				try {
					const response = await ctx.fetch(
						`http://${loaded.config.listeners.management.address}/probe/${site.host}`,
						{ headers: { host: site.host } }
					);
					return {
						status: response.status,
						body: new Uint8Array(await response.arrayBuffer())
					};
				} catch {
					return { status: 0, body: new Uint8Array() };
				}
			},
			teardown: async () => {
				const scratch = `${loaded.state}/drill/${site.host}/${site.host}.sqlite`;
				if (ctx.files.exists(scratch)) ctx.files.remove(scratch);
			}
		});
		results.push(result);
	}

	emit(ctx, globals, { results }, () =>
		results
			.map((result) =>
				[
					`${result.site} version ${result.version ?? '(none)'}: ${result.ok ? 'passed' : 'FAILED'}`,
					...result.steps.map(
						(step) => `  ${step.ok ? 'ok  ' : 'fail'} ${step.step}: ${step.detail}`
					)
				].join('\n')
			)
			.join('\n\n')
	);
	return results.every((result) => result.ok) ? 0 : 3;
}
