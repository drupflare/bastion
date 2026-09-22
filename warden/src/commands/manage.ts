import type { BastionConfig, Context, TenantConfig } from '@drupflare/bastion';
import {
	BastionError,
	DEFAULT_CAPABILITIES,
	firecrackerHypervisor,
	parseAddress,
	probeProfile,
	writeConfig
} from '@drupflare/bastion';
import { kv, table, yesNo } from '../format';
import { emit, load, writePath, type Globals, type Loaded } from '../state';

function write(ctx: Context, globals: Globals, loaded: Loaded, config: BastionConfig): string {
	return writeConfig(ctx, writePath(ctx, globals, loaded), config);
}

function tenantOrRefuse(loaded: Loaded, name: string): TenantConfig {
	const tenant = loaded.config.tenants.find((entry) => entry.name === name);
	if (tenant === undefined) {
		throw new BastionError('usage', `there is no tenant called ${name}`, {
			next: 'bastion tenant list'
		});
	}
	return tenant;
}

function replaceTenant(
	loaded: Loaded,
	name: string,
	patch: (tenant: TenantConfig) => TenantConfig
): BastionConfig {
	return {
		...loaded.config,
		tenants: loaded.config.tenants.map((entry) => (entry.name === name ? patch(entry) : entry))
	};
}

// #region tenants

/**
 * Stops a tenant and keeps everything it owns.
 *
 * The distinction from `tenant rm` is the whole command: suspending keeps the sites, the storage
 * and the certificates, so resuming is one word rather than a restore.
 */
export function runTenantSuspend(ctx: Context, globals: Globals, name: string): void {
	const loaded = load(ctx, globals);
	const tenant = tenantOrRefuse(loaded, name);
	if (tenant.suspended === true) {
		emit(
			ctx,
			globals,
			{ tenant: name, suspended: true, changed: false },
			() => `${name} is already suspended`
		);
		return;
	}
	const path = write(
		ctx,
		globals,
		loaded,
		replaceTenant(loaded, name, (entry) => ({ ...entry, suspended: true }))
	);
	emit(ctx, globals, { tenant: name, suspended: true, changed: true, path }, () =>
		[
			kv([
				['suspended', name],
				['sites', String(tenant.sites.length)],
				['state', 'kept']
			]),
			'',
			`its sites stop answering on the next \`bastion reload\`. Resume with ` +
				`\`bastion tenant resume ${name}\``
		].join('\n')
	);
}

export function runTenantResume(ctx: Context, globals: Globals, name: string): void {
	const loaded = load(ctx, globals);
	const tenant = tenantOrRefuse(loaded, name);
	if (tenant.suspended !== true) {
		emit(
			ctx,
			globals,
			{ tenant: name, suspended: false, changed: false },
			() => `${name} is not suspended`
		);
		return;
	}
	const path = write(
		ctx,
		globals,
		loaded,
		replaceTenant(loaded, name, ({ suspended: _was, ...rest }) => rest)
	);
	emit(
		ctx,
		globals,
		{ tenant: name, suspended: false, changed: true, path },
		() => `${name} resumed; run \`bastion reload\` to start it`
	);
}

/** one tenant's egress policy, which is deny-by-default and therefore worth printing in full */
export function runTenantEgress(ctx: Context, globals: Globals, name: string): void {
	const loaded = load(ctx, globals);
	const tenant = tenantOrRefuse(loaded, name);
	const allow = tenant.egress?.allow ?? [];
	emit(ctx, globals, { tenant: name, allow }, () =>
		allow.length === 0
			? `${name} has no allow list, so every outbound connection is denied`
			: [
					`${name} may reach:`,
					...allow.map((entry) => `  ${entry}`),
					'',
					'everything else is denied'
				].join('\n')
	);
}

// #endregion

// #region sites

export function runSiteShow(ctx: Context, globals: Globals, host: string): void {
	const loaded = load(ctx, globals);
	const owner = loaded.config.tenants.find((tenant) =>
		tenant.sites.some((site) => site.host === host)
	);
	const site = owner?.sites.find((entry) => entry.host === host);
	if (owner === undefined || site === undefined) {
		throw new BastionError('usage', `no tenant holds ${host}`, { next: 'bastion site list' });
	}
	const capabilities = { ...DEFAULT_CAPABILITIES, ...(owner.capabilities ?? {}) };
	emit(ctx, globals, { site, tenant: owner.name, capabilities }, () =>
		[
			kv([
				['host', site.host],
				['tenant', owner.name],
				['bundle', site.bundle],
				['probe', site.probe ?? '(none)'],
				['aliases', site.aliases?.join(', ') ?? '(none)'],
				['primary node', site.primary ?? '(this node)'],
				['replicas', site.replicas?.join(', ') ?? '(none)'],
				['force https', yesNo(site.forceHttps === true)],
				[
					'verified',
					site.verifiedAt === undefined ? 'no' : new Date(site.verifiedAt).toISOString()
				]
			]),
			'',
			table(
				['capability', 'value'],
				Object.entries(capabilities).map(([key, value]) => [key, String(value)])
			)
		].join('\n')
	);
}

/**
 * Which address the probe dials, and what it will not have checked as a result.
 *
 * The local listener, so the answer is about THIS box. Building the url out of the hostname and
 * letting DNS choose the destination is how `site probe www.example.edu` on a box with no DNS
 * record reached IANA's example server over the public internet, read its 200, and reported the
 * site answering. During a migration that is the machine being migrated OFF, which is the one
 * moment the command exists for and the one answer it must not give.
 *
 * http where there is a listener, because the loopback hop is inside the box and a self-signed
 * certificate on the https one would fail a chain check for a reason that has nothing to do with
 * whether the worker serves.
 *
 * The chain goes unchecked only on loopback, where the request cannot leave the machine. An https
 * listener on a routable address is verified like any other, and a chain that does not verify
 * there is a real finding rather than noise to suppress.
 */
function probeTarget(config: BastionConfig): { url: string; verified: boolean } | null {
	const http = config.listeners.http?.address;
	if (http !== undefined) return { url: `http://${http}/`, verified: true };
	const https = config.listeners.https?.address;
	if (https === undefined) return null;
	const host = parseAddress(https).hostname;
	const local = host === '127.0.0.1' || host === '::1' || host === 'localhost';
	return { url: `https://${https}/`, verified: !local };
}

/**
 * Asks the site to prove it booted, on a path the prefill cannot answer.
 *
 * A probe against a cached path proves the cache works and nothing else, which is why the profile
 * carries the path rather than the command choosing one.
 *
 * `--public` resolves the hostname instead, for an operator confirming the whole path after a
 * cutover: DNS, the certificate and anything in front. It answers a different question and says so.
 */
export async function runSiteProbe(
	ctx: Context,
	globals: Globals & { public?: boolean },
	host: string
): Promise<number> {
	const loaded = load(ctx, globals);
	const owner = loaded.config.tenants.find((tenant) =>
		tenant.sites.some((site) => site.host === host)
	);
	const site = owner?.sites.find((entry) => entry.host === host);
	if (owner === undefined || site === undefined) {
		throw new BastionError('usage', `no tenant holds ${host}`, { next: 'bastion site list' });
	}

	const through = globals.public === true;
	const target = through
		? { url: `https://${host}/`, verified: true }
		: probeTarget(loaded.config);
	if (target === null) {
		throw new BastionError('config-invalid', 'this box binds no listener to probe', {
			next: 'bastion config set listeners.http.address'
		});
	}

	// the header comes from the profile: an arbitrary worker sets none, and demanding one would
	// fail a site that is answering perfectly well
	const profile = probeProfile(site.probe);
	let answered: { status: number; booted: string | null } | null = null;
	let failure: string | null = null;
	try {
		const response = await ctx.fetch(target.url, {
			headers: { host },
			...(target.verified ? {} : { tls: { rejectUnauthorized: false } })
		} as RequestInit);
		answered = {
			status: response.status,
			booted: profile.bootHeader === null ? null : response.headers.get(profile.bootHeader)
		};
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}

	const ok = answered !== null && answered.status < 500;
	emit(
		ctx,
		globals,
		{
			host,
			profile: site.probe ?? null,
			url: target.url,
			reached: through ? 'dns' : 'this box',
			chainVerified: target.verified,
			answered,
			failure,
			ok
		},
		() =>
			[
				kv([
					['site', host],
					['profile', site.probe ?? '(none)'],
					['dialled', target.url],
					['reached', through ? 'whatever dns answers for this host' : 'this box'],
					[
						'status',
						answered === null ? `unreachable: ${failure}` : String(answered.status)
					],
					[
						'booted',
						profile.bootHeader === null
							? '(profile sets no boot header)'
							: (answered?.booted ?? '(header absent)')
					]
				]),
				...(target.verified
					? []
					: ['', 'the certificate chain was not checked; run `bastion cert list`']),
				'',
				ok
					? through
						? 'the site answered, though not necessarily from this box'
						: 'this box served the site'
					: 'the site did not answer; is bastion running?'
			].join('\n')
	);
	return ok ? 0 : 3;
}

// #endregion

// #region egress

function editAllow(
	ctx: Context,
	globals: Globals,
	tenant: string,
	target: string,
	change: (allow: string[]) => string[]
): { allow: string[]; path: string } {
	const loaded = load(ctx, globals);
	const found = tenantOrRefuse(loaded, tenant);
	const allow = change(found.egress?.allow ?? []);
	const path = write(
		ctx,
		globals,
		loaded,
		replaceTenant(loaded, tenant, (entry) => ({ ...entry, egress: { allow } }))
	);
	void target;
	return { allow, path };
}

/** adds one `host:port` to a tenant's allow list; everything outside it stays denied */
export function runEgressAllow(
	ctx: Context,
	globals: Globals,
	tenant: string,
	target: string
): void {
	if (!/^[a-z0-9.*-]+:\d+$/i.test(target)) {
		throw new BastionError('usage', `${target} is not a host:port`, {
			next: `bastion egress allow ${tenant} smtp.example.edu:587`
		});
	}
	const { allow } = editAllow(ctx, globals, tenant, target, (current) =>
		current.includes(target) ? current : [...current, target].sort()
	);
	emit(
		ctx,
		globals,
		{ tenant, target, allow },
		() =>
			`${tenant} may now reach ${target}; ${allow.length} rule${allow.length === 1 ? '' : 's'} in total`
	);
}

export function runEgressDeny(
	ctx: Context,
	globals: Globals,
	tenant: string,
	target: string
): number {
	const loaded = load(ctx, globals);
	const found = tenantOrRefuse(loaded, tenant);
	if (!(found.egress?.allow ?? []).includes(target)) {
		emit(
			ctx,
			globals,
			{ tenant, target, changed: false },
			() => `${tenant} was not allowed to reach ${target}; it is denied either way`
		);
		return 3;
	}
	const { allow } = editAllow(ctx, globals, tenant, target, (current) =>
		current.filter((entry) => entry !== target)
	);
	emit(
		ctx,
		globals,
		{ tenant, target, allow, changed: true },
		() => `${tenant} can no longer reach ${target}`
	);
	return 0;
}

// #endregion

// #region guests

function guestOrRefuse(ctx: Context, globals: Globals, tenant: string) {
	const loaded = load(ctx, globals);
	if (loaded.config.mode !== 'isolated') {
		throw new BastionError(
			'capability-refused',
			`there are no guests in \`${loaded.config.mode}\`; guests exist only in \`isolated\``,
			{ next: 'bastion config set mode isolated' }
		);
	}
	const hypervisor = firecrackerHypervisor();
	const reason = hypervisor.unavailableReason(ctx);
	if (reason !== null) throw new BastionError('driver-unreachable', reason);
	const guest = hypervisor.list().find((entry) => entry.tenant === tenant);
	if (guest === undefined) {
		throw new BastionError('usage', `${tenant} has no guest running`, {
			next: 'bastion vm list'
		});
	}
	return { hypervisor, guest };
}

export function runVmShow(ctx: Context, globals: Globals, tenant: string): void {
	const { guest } = guestOrRefuse(ctx, globals, tenant);
	emit(ctx, globals, guest, () =>
		kv([
			['tenant', guest.tenant],
			['state', guest.state],
			['pid', String(guest.pid ?? '-')],
			['chroot', guest.chroot]
		])
	);
}

/**
 * Names the console rather than attaching to it.
 *
 * The jailer chroot is 0700 and the socket lives inside it, so attaching needs the privilege the
 * CLI deliberately does not assume. Printing the exact command is the honest answer.
 */
export function runVmConsole(ctx: Context, globals: Globals, tenant: string): void {
	const { guest } = guestOrRefuse(ctx, globals, tenant);
	const socket = `${guest.chroot}/root/console.sock`;
	emit(ctx, globals, { tenant, chroot: guest.chroot, socket }, () =>
		[
			kv([
				['tenant', tenant],
				['chroot', guest.chroot],
				['console', socket]
			]),
			'',
			`attach with: sudo socat - UNIX-CONNECT:${socket}`,
			'the jailer chroot is 0700, so this needs the privilege bastion does not take for you'
		].join('\n')
	);
}

export async function runVmStop(ctx: Context, globals: Globals, tenant: string): Promise<void> {
	const { hypervisor, guest } = guestOrRefuse(ctx, globals, tenant);
	await hypervisor.stop(ctx, guest.tenant);
	emit(
		ctx,
		globals,
		{ tenant, stopped: true },
		() => `${tenant}'s guest stopped; its state on disk is untouched`
	);
}

// #endregion
