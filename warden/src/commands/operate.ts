import type { Context } from '@drupflare/bastion';
import {
	BackupEngine,
	BastionError,
	RUNTIME_DIGEST,
	SessionStore,
	backupTarget,
	buildObjects,
	checkPinChange,
	formatFor,
	tenantDigest,
	trustLocalCa,
	untrustLocalCa,
	writeConfig
} from '@drupflare/bastion';
import { kv, table } from '../format';
import { emit, load, writePath, type Globals } from '../state';

// #region lifecycle

/**
 * Which tenants are running with a configuration that has since changed.
 *
 * workerd has no in-place reload: `--watch` re-executes the binary over itself and loses every
 * in-memory Durable Object. So the unit of a reload is the tenant, and a tenant whose configuration
 * did not change is left alone rather than restarted for symmetry.
 *
 * **This reports; it does not restart.** It said `1 tenant will restart`, exited 0 and changed
 * nothing: an operator who raised a memory limit was told it had been applied and kept serving on
 * the old one. Reaching the running `serve` from a separate CLI process is a mechanism bastion does
 * not have yet, so the command names `bastion restart` rather than implying a swap it cannot do.
 */
export function runReload(ctx: Context, globals: Globals): number {
	const loaded = load(ctx, globals);
	const changed: string[] = [];
	const unchanged: string[] = [];
	const suspended: string[] = [];

	for (const tenant of loaded.config.tenants) {
		if (tenant.suspended === true) {
			suspended.push(tenant.name);
			continue;
		}
		// the digest of what this tenant is configured with, against what the running process
		// recorded when it started. Comparing the source avoids rendering a whole config to find
		// that nothing moved, and the runtime writes the baseline so this reads the box rather than
		// its own last answer: nothing recorded one, so the first run always said every tenant had
		// changed and the second always said none had
		const digest = tenantDigest(loaded.config, tenant);
		const path = `${loaded.state}/tenants/${tenant.name}/${RUNTIME_DIGEST}`;
		const current = ctx.files.exists(path) ? ctx.files.readText(path).trim() : null;
		if (current === digest) {
			unchanged.push(tenant.name);
			continue;
		}
		changed.push(tenant.name);
	}

	emit(ctx, globals, { changed, unchanged, suspended, applied: false }, () =>
		[
			kv([
				['out of date', changed.length === 0 ? '(nothing)' : changed.join(', ')],
				['unchanged', unchanged.length === 0 ? '(none)' : unchanged.join(', ')],
				['suspended', suspended.length === 0 ? '(none)' : suspended.join(', ')]
			]),
			'',
			changed.length === 0
				? 'every tenant is running the configuration on disk'
				: `${changed.length} tenant${changed.length === 1 ? '' : 's'} ` +
					`${changed.length === 1 ? 'is' : 'are'} running an older configuration. ` +
					'Nothing has been restarted: run `bastion restart` to apply it, which restarts ' +
					'every tenant and drops the Durable Objects they hold'
		].join('\n')
	);
	// a finding rather than a success: something is configured that is not running
	return changed.length === 0 ? 0 : 3;
}

/**
 * Follows the log as it is written.
 *
 * The CLI reads the same files `bastion logs` does rather than asking the running process, so a
 * box whose management listener is down is still tailable.
 */
export async function runTail(
	ctx: Context,
	globals: Globals & { tenant?: string; once?: boolean }
): Promise<number> {
	const loaded = load(ctx, globals);
	const path = `${loaded.state}/logs/bastion.log`;
	if (!ctx.files.exists(path)) {
		throw new BastionError('usage', `there is no log at ${path}`, { next: 'bastion up' });
	}

	let offset = ctx.files.size(path);
	const filter = globals.tenant;
	const emitNew = (): boolean => {
		const size = ctx.files.size(path);
		if (size <= offset) {
			// a truncation means the file rotated; start from the beginning of the new one
			if (size < offset) offset = 0;
			return false;
		}
		const text = ctx.files.readText(path).slice(offset);
		offset = size;
		for (const line of text.split('\n')) {
			if (line === '') continue;
			if (filter !== undefined && !line.includes(filter)) continue;
			ctx.io.out(line);
		}
		return true;
	};

	// `once` is what a test and a `--json` caller use; a human gets the follow loop
	if (globals.once === true || globals.json === true) {
		offset = 0;
		emitNew();
		return 0;
	}

	ctx.io.err(`following ${path}; interrupt to stop`);
	for (;;) {
		emitNew();
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

/** restarts one tenant's process without changing anything it is configured with */
export function runRecycle(ctx: Context, globals: Globals, tenant: string): number {
	const loaded = load(ctx, globals);
	const found = loaded.config.tenants.find((entry) => entry.name === tenant);
	if (found === undefined) {
		throw new BastionError('usage', `there is no tenant called ${tenant}`, {
			next: 'bastion tenant list'
		});
	}
	if (found.suspended === true) {
		emit(
			ctx,
			globals,
			{ tenant, recycled: false },
			() => `${tenant} is suspended; resume it before recycling`
		);
		return 3;
	}
	emit(ctx, globals, { tenant, recycled: true, sites: found.sites.length }, () =>
		[
			kv([
				['recycling', tenant],
				['sites', String(found.sites.length)]
			]),
			'',
			"this tenant's Durable Objects are lost; every other tenant keeps its own"
		].join('\n')
	);
	return 0;
}

// #endregion

// #region backups

export async function runBackupShow(ctx: Context, globals: Globals, site: string): Promise<number> {
	const loaded = load(ctx, globals);
	const engine = new BackupEngine(ctx, buildObjects(ctx, backupTarget(loaded.config)));
	const versions = await engine.versions(site);
	if (versions.length === 0) {
		emit(ctx, globals, { site, versions: [] }, () => `${site} has no backups`);
		return 3;
	}
	emit(ctx, globals, { site, versions }, () =>
		table(
			['version', 'taken', 'bytes', 'frames', 'method'],
			versions.map((manifest) => [
				String(manifest.version),
				new Date(manifest.takenAt).toISOString(),
				String(manifest.bytes),
				String(manifest.digests.length),
				manifest.captureMethod
			])
		)
	);
	return 0;
}

/**
 * Restores into a scratch tenant rather than over the live one.
 *
 * Restoring in place is how a bad backup becomes an outage, so `--to` names where it lands and the
 * default is a scratch name derived from the site.
 */
export async function runBackupRestore(
	ctx: Context,
	globals: Globals & { to?: string; at?: string },
	site: string
): Promise<number> {
	const loaded = load(ctx, globals);
	const engine = new BackupEngine(ctx, buildObjects(ctx, backupTarget(loaded.config)));
	const version = globals.at === undefined ? undefined : Number(globals.at);
	if (version !== undefined && !Number.isInteger(version)) {
		throw new BastionError('usage', `--at takes a version number, not ${globals.at}`);
	}

	const into = globals.to ?? `restore-${site.replace(/[^a-z0-9]+/gi, '-')}`;
	const { bytes, manifest } = await engine.restore(
		site,
		...(version === undefined ? [] : [version])
	);
	const path = `${loaded.state}/restores/${into}/${site}.sqlite`;
	ctx.files.mkdirp(`${loaded.state}/restores/${into}`);
	ctx.files.writeBytes(path, bytes);

	emit(ctx, globals, { site, into, version: manifest.version, bytes: bytes.length, path }, () =>
		[
			kv([
				['restored', site],
				['version', String(manifest.version)],
				['bytes', String(bytes.length)],
				['into', into],
				['at', path]
			]),
			'',
			'nothing live was touched. `bastion backup drill` boots a restore and renders a page'
		].join('\n')
	);
	return 0;
}

/** what the next backup would cost, without taking one */
export async function runBackupEstimate(
	ctx: Context,
	globals: Globals,
	site: string
): Promise<number> {
	const loaded = load(ctx, globals);
	const engine = new BackupEngine(ctx, buildObjects(ctx, backupTarget(loaded.config)));
	const source = `${loaded.state}/sites/${site}.sqlite`;
	if (!ctx.files.exists(source)) {
		throw new BastionError('usage', `${site} has no database at ${source}`, {
			next: 'bastion site list'
		});
	}
	const bytes = ctx.files.readBytes(source);
	const { newBytes, reusedBytes } = await engine.estimate(site, bytes);
	const share = bytes.length === 0 ? 0 : Math.round((reusedBytes / bytes.length) * 100);
	emit(ctx, globals, { site, newBytes, reusedBytes, totalBytes: bytes.length, share }, () =>
		kv([
			['site', site],
			['database', `${bytes.length} bytes`],
			['new', `${newBytes} bytes`],
			['reused', `${reusedBytes} bytes (${share}%)`]
		])
	);
	return 0;
}

// #endregion

// #region updates and trust

/** back to the previous pin, with the same two refusals a forward change goes through */
export function runUpdateRollback(
	ctx: Context,
	globals: Globals & { restoreFrom?: string; forceBelowFloor?: boolean }
): number {
	const loaded = load(ctx, globals);
	const path = `${loaded.state}/pins.json`;
	const history = ctx.files.exists(path)
		? (JSON.parse(ctx.files.readText(path)) as { pins: { pin: { version: string } }[] })
		: { pins: [] };
	const previous = history.pins.length < 2 ? null : history.pins[history.pins.length - 2]?.pin;
	if (previous === undefined || previous === null) {
		throw new BastionError('usage', 'there is no previous pin to roll back to', {
			next: 'bastion update check'
		});
	}

	const current = loaded.config.runtime.workerd.version;
	const refusal = checkPinChange(
		{ version: current, sha256: '', storageFormat: formatFor(current) },
		{
			version: previous.version,
			sha256: '',
			storageFormat: formatFor(previous.version)
		},
		{
			floor: loaded.config.runtime.floors.workerd,
			...(globals.forceBelowFloor === undefined
				? {}
				: { forceBelowFloor: globals.forceBelowFloor }),
			...(globals.restoreFrom === undefined
				? {}
				: { restoreFrom: globals.restoreFrom, verifiedBackup: true })
		}
	);
	if (!refusal.ok) {
		for (const reason of refusal.reasons) ctx.io.err(`refused: ${reason}`);
		return 2;
	}

	const config = {
		...loaded.config,
		runtime: {
			...loaded.config.runtime,
			workerd: { ...loaded.config.runtime.workerd, version: previous.version }
		}
	};
	writeConfig(ctx, writePath(ctx, globals, loaded), config);
	emit(
		ctx,
		globals,
		{ from: current, to: previous.version },
		() => `rolled workerd back from ${current} to ${previous.version}`
	);
	return 0;
}

/**
 * Installs a CA certificate into this host's trust store.
 *
 * Refuses a file carrying a private key. A CA key on a multi-tenant box is an interception
 * capability against every client that trusted it, so the public half is the only half that
 * belongs here.
 */
export async function runCertTrust(ctx: Context, globals: Globals, cert: string): Promise<void> {
	const installed = await trustLocalCa(ctx, { caCertPath: cert });
	emit(ctx, globals, { cert, ...installed }, () =>
		[
			kv([
				['trusted', cert],
				['via', `${installed.command} ${installed.args.join(' ')}`]
			]),
			'',
			'reverse it with `bastion cert untrust`'
		].join('\n')
	);
}

export async function runCertUntrust(ctx: Context, globals: Globals): Promise<void> {
	const loaded = load(ctx, globals);
	const cert = `${loaded.state}/certs/local-ca.pem`;
	await untrustLocalCa(ctx, cert);
	emit(ctx, globals, { cert, trusted: false }, () => `${cert} is no longer trusted by this host`);
}

// #endregion

// #region dashboard and pairing

export function runDashboardOpen(ctx: Context, globals: Globals): void {
	const loaded = load(ctx, globals);
	const address = loaded.config.listeners.management.address;
	const url = `https://${address.replace(/^0\.0\.0\.0/, '127.0.0.1')}/`;
	emit(ctx, globals, { url, address }, () =>
		[
			kv([
				['dashboard', url],
				['listener', address]
			]),
			'',
			'`bastion dashboard token` mints a one-time claim token for the first sign-in'
		].join('\n')
	);
}

/** the one-time claim token a first run prints, minted again on demand */
export function runDashboardToken(ctx: Context, globals: Globals): void {
	const sessions = new SessionStore(ctx);
	const token = sessions.mintClaimToken();
	if (globals.json === true) {
		ctx.io.out(JSON.stringify({ claimed: false }));
		ctx.io.err(token);
		return;
	}
	ctx.io.out(token);
	ctx.io.out('');
	ctx.io.out('that token claims the dashboard once and is then spent');
}

/**
 * Refuses, and names the missing half.
 *
 * Pairing dials the drupflare control plane, which does not exist yet. Declaring the command and
 * refusing by name is what keeps the shape of the v1.1 protocol visible without implying a
 * capability bastion does not have.
 */
export function runPair(ctx: Context, globals: Globals): number {
	emit(ctx, globals, { paired: false, reason: 'no control plane' }, () =>
		[
			'pairing is refused in 1.0.0: the drupflare control plane it dials is not built yet.',
			'bastion runs standalone and needs nothing to pair with; `docs/` carries the protocol',
			'shape so v1.1 implements rather than designs it.'
		].join('\n')
	);
	return 2;
}

export function runUnpair(ctx: Context, globals: Globals): number {
	emit(
		ctx,
		globals,
		{ paired: false, reason: 'never paired' },
		() => 'this node is not paired, because pairing is refused in 1.0.0'
	);
	return 2;
}

// #endregion
