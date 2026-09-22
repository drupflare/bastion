import type { Context, Version } from '@drupflare/bastion';
import { BastionError, VersionStore, pickVersion } from '@drupflare/bastion';
import { kv, table } from '../format';
import { emit, load, type Globals, type Loaded } from '../state';

/** one store per state directory, so two processes see the same versions */
function store(ctx: Context, loaded: Loaded): VersionStore {
	return new VersionStore({ ctx, path: `${loaded.state}/versions.json` });
}

function siteOrRefuse(loaded: Loaded, host: string): { tenant: string; host: string } {
	for (const tenant of loaded.config.tenants) {
		for (const site of tenant.sites) {
			if (site.host === host) return { tenant: tenant.name, host };
		}
	}
	throw new BastionError('usage', `no tenant holds ${host}`, { next: 'bastion site list' });
}

const bytes = (n: number): string =>
	n < 1024
		? `${n} B`
		: n < 1024 ** 2
			? `${(n / 1024).toFixed(1)} KiB`
			: `${(n / 1024 ** 2).toFixed(1)} MiB`;

export function runDeploy(ctx: Context, globals: Globals, host: string, bundle: string): void {
	const loaded = load(ctx, globals);
	siteOrRefuse(loaded, host);
	if (!ctx.files.exists(bundle)) {
		throw new BastionError('usage', `${bundle} is not there`);
	}
	const payload = ctx.files.readBytes(bundle);
	const versions = store(ctx, loaded);
	const version = versions.add(host, payload, 'operator', ctx.now(), { bundle });
	const deployment = versions.deploy(host, version.id, 'operator', ctx.now());
	emit(ctx, globals, { version, deployment }, () =>
		kv([
			['deployed', host],
			['version', version.id],
			['size', bytes(version.bytes)],
			['from', bundle]
		])
	);
}

export function runVersionList(ctx: Context, globals: Globals, host: string): void {
	const loaded = load(ctx, globals);
	siteOrRefuse(loaded, host);
	const versions = store(ctx, loaded);
	const all = versions.list(host);
	const current = versions.deployment(host);
	emit(ctx, globals, { versions: all, deployment: current }, () =>
		all.length === 0
			? `${host} has no versions; run \`bastion deploy ${host} <bundle>\``
			: table(
					['version', 'size', 'uploaded', 'state'],
					all.map((version) => [
						version.id,
						bytes(version.bytes),
						new Date(version.uploadedAt).toISOString(),
						state(version, current)
					])
				)
	);
}

function state(
	version: Version,
	current: { current: string; split: { version: string; percent: number } | null } | null
): string {
	if (current === null) return '';
	if (current.current === version.id) return 'live';
	if (current.split?.version === version.id) return `${current.split.percent}% split`;
	return '';
}

export function runVersionShow(ctx: Context, globals: Globals, host: string, id: string): void {
	const loaded = load(ctx, globals);
	siteOrRefuse(loaded, host);
	const version = store(ctx, loaded).get(host, id);
	if (version === null) {
		throw new BastionError('usage', `${host} has no version ${id}`, {
			next: `bastion version list ${host}`
		});
	}
	emit(ctx, globals, version, () =>
		kv([
			['version', version.id],
			['site', version.site],
			['size', bytes(version.bytes)],
			['uploaded', new Date(version.uploadedAt).toISOString()],
			['by', version.uploadedBy],
			...Object.entries(version.annotations)
		])
	);
}

/**
 * What differs between two versions.
 *
 * bastion stores the content address and the size rather than the bundle, so this compares what it
 * holds and says so, instead of implying a file diff it cannot produce.
 */
export function runVersionDiff(
	ctx: Context,
	globals: Globals,
	host: string,
	from: string,
	to: string
): number {
	const loaded = load(ctx, globals);
	siteOrRefuse(loaded, host);
	const versions = store(ctx, loaded);
	const left = versions.get(host, from);
	const right = versions.get(host, to);
	for (const [id, found] of [
		[from, left],
		[to, right]
	] as const) {
		if (found === null) throw new BastionError('usage', `${host} has no version ${id}`);
	}
	const same = left?.id === right?.id;
	const report = {
		host,
		from: left,
		to: right,
		identical: same,
		bytesDelta: (right?.bytes ?? 0) - (left?.bytes ?? 0)
	};
	emit(ctx, globals, report, () =>
		[
			kv([
				['site', host],
				['from', `${left?.id} (${bytes(left?.bytes ?? 0)})`],
				['to', `${right?.id} (${bytes(right?.bytes ?? 0)})`],
				['size change', `${report.bytesDelta >= 0 ? '+' : ''}${report.bytesDelta} bytes`]
			]),
			'',
			same
				? 'these are the same bundle: the content address matches'
				: 'these are different bundles. bastion stores the address, not the contents, so ' +
					'compare the artifacts themselves for a file-level diff'
		].join('\n')
	);
	return same ? 0 : 3;
}

export function runVersionPin(ctx: Context, globals: Globals, host: string, id: string): void {
	const loaded = load(ctx, globals);
	siteOrRefuse(loaded, host);
	const versions = store(ctx, loaded);
	const deployment = versions.deploy(host, id, 'operator', ctx.now());
	emit(ctx, globals, deployment, () =>
		kv([
			['pinned', host],
			['version', deployment.current],
			['split', 'cleared']
		])
	);
}

export function runRollout(
	ctx: Context,
	globals: Globals & { version?: string; percent?: string },
	host: string
): void {
	const loaded = load(ctx, globals);
	siteOrRefuse(loaded, host);
	if (globals.version === undefined) {
		throw new BastionError('usage', 'name the version to roll out with --version');
	}
	const percent = Number(globals.percent ?? '10');
	const versions = store(ctx, loaded);
	const deployment = versions.rollout(host, globals.version, percent, 'operator', ctx.now());
	// shown against a real key, so the split reads as the router will actually apply it
	const sample = pickVersion(deployment, 'example-session');
	emit(ctx, globals, { deployment, sample }, () =>
		kv([
			['site', host],
			['current', deployment.current],
			['canary', deployment.split?.version ?? '(none)'],
			['share', `${deployment.split?.percent ?? 0}%`],
			['a sample session goes to', sample]
		])
	);
}

export function runRollback(ctx: Context, globals: Globals & { to?: string }, host: string): void {
	const loaded = load(ctx, globals);
	siteOrRefuse(loaded, host);
	const versions = store(ctx, loaded);
	const deployment = versions.rollback(
		host,
		'operator',
		ctx.now(),
		...(globals.to === undefined ? [] : [globals.to])
	);
	emit(ctx, globals, deployment, () =>
		kv([
			['rolled back', host],
			['now serving', deployment.current]
		])
	);
}

/**
 * The portable artifact, which is the same one a migration reads.
 *
 * bastion writes the manifest it can produce offline and names the route that carries the site's
 * own data, rather than pretending the CLI can dump a running Durable Object without the site.
 */
export function runExport(ctx: Context, globals: Globals, host: string): void {
	const loaded = load(ctx, globals);
	const site = siteOrRefuse(loaded, host);
	const versions = store(ctx, loaded);
	const artifact = {
		host,
		tenant: site.tenant,
		exportedAt: ctx.now(),
		versions: versions.list(host),
		deployment: versions.deployment(host),
		source: `${host}/export`
	};
	emit(ctx, globals, artifact, () =>
		[
			kv([
				['site', host],
				['tenant', site.tenant],
				['versions', String(artifact.versions.length)],
				['live', artifact.deployment?.current ?? '(nothing deployed)']
			]),
			'',
			`the site's own content comes from GET https://${host}/export with the owner token; ` +
				'this manifest is the plane half'
		].join('\n')
	);
}

export function runImport(ctx: Context, globals: Globals, host: string, artifact: string): void {
	const loaded = load(ctx, globals);
	siteOrRefuse(loaded, host);
	if (!ctx.files.exists(artifact)) {
		throw new BastionError('usage', `${artifact} is not there`);
	}
	const payload = ctx.files.readBytes(artifact);
	const versions = store(ctx, loaded);
	const version = versions.add(host, payload, 'operator', ctx.now(), { imported: artifact });
	emit(ctx, globals, { host, version }, () =>
		[
			kv([
				['imported', host],
				['version', version.id],
				['size', bytes(version.bytes)]
			]),
			'',
			`nothing is live yet: run \`bastion version pin ${host} ${version.id}\``
		].join('\n')
	);
}
