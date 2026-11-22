import type {
	AssetInstall,
	Context,
	ExecResult,
	Executors,
	PreparedBundle,
	Runtime,
	TenantConfig
} from '@drupflare/bastion';
import {
	BastionError,
	EXIT,
	FleetLink,
	PairStore,
	ParamError,
	admitSite,
	buildSecrets,
	capacity,
	defaultCostModel,
	installAssets,
	memoryIo,
	nameOf,
	prepareBundle,
	pullBundle,
	readHost,
	sha256Of,
	tenantAssets
} from '@drupflare/bastion';
import { hostname } from 'node:os';
import { setTenantSuspended } from './commands/manage';
import { downloadOptions } from './download';
import { run } from './run';
import { load, type Globals, type Loaded } from './state';

const HOST = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHECKSUM = /^sha256:[0-9a-f]{64}$/;
const BUNDLE_URL = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~%/+=-]*$/;
const BUNDLE_PATH = /^\/[A-Za-z0-9._/-]{1,512}$/;
const TENANT = /^[a-z0-9][a-z0-9-]{0,62}$/;
// a box that hashes names shows the control plane `h:` digests, so a command may name one
const TENANT_REF = /^(?:[a-z0-9][a-z0-9-]{0,62}|h:[0-9a-f]{24})$/;
const CPU = /^\d{1,3}(\.\d{1,3})?$/;
const MEMORY = /^[1-9]\d{0,11}(Ki|Mi|Gi|Ti)?$/;

function count(raw: Record<string, unknown>, key: string, max: number): number | null {
	const value = raw[key];
	if (value === undefined) return null;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
		throw new ParamError(`${key} is not acceptable`);
	}
	return value;
}

/** the parameters an action takes and no others, so an extra key is a refusal and not a guess */
function only(raw: Record<string, unknown>, allowed: string[]): void {
	for (const key of Object.keys(raw)) {
		if (!allowed.includes(key)) throw new ParamError(`unexpected parameter ${key}`);
	}
}

function text(
	raw: Record<string, unknown>,
	key: string,
	pattern: RegExp,
	optional = false
): string {
	const value = raw[key];
	if (value === undefined && optional) return '';
	if (typeof value !== 'string' || !pattern.test(value)) {
		throw new ParamError(`${key} is not acceptable`);
	}
	return value;
}

interface Outcome {
	ok: boolean;
	code: string | null;
	json: Record<string, unknown> | null;
}

/**
 * Runs one of the CLI's own commands and reads back only whether it worked.
 *
 * It goes through the same `run` the binary calls, under `--json` against a capturing io, which is
 * how the management API reaches its operations. No shell is involved: the argument list is built
 * from validated parameters and handed to the command table, and an argument that could be read as
 * a flag is refused before it gets here.
 */
async function cli(ctx: Context, globals: Globals, argv: string[]): Promise<Outcome> {
	const io = memoryIo();
	const base = globals.config === undefined ? [] : ['--config', globals.config];
	const code = await run({ ...ctx, io }, [...base, ...argv, '--json']);
	const lines = io.outText().trim().split('\n');
	let json: Record<string, unknown> | null = null;
	try {
		const parsed: unknown = JSON.parse(lines[lines.length - 1] ?? '');
		if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>;
	} catch {
		json = null;
	}
	if (code === EXIT.OK || code === EXIT.FINDING) return { ok: true, code: null, json };
	const error = (json as { error?: { code?: unknown } } | null)?.error;
	return { ok: false, code: typeof error?.code === 'string' ? error.code : 'failed', json };
}

function deployed(outcome: Outcome): { version: string; deployedAt: string } | null {
	const deployment = (outcome.json?.deployment ?? outcome.json) as
		{ current?: unknown; at?: unknown } | undefined;
	if (typeof deployment?.current !== 'string' || typeof deployment.at !== 'number') return null;
	return {
		version: deployment.current,
		deployedAt: new Date(deployment.at).toISOString().replace(/\.\d{3}Z$/, 'Z')
	};
}

/**
 * What the control plane may ask this box to do, and the class each action belongs to.
 *
 * Eleven actions, each an existing command. Removing a tenant is the one destructive action: the
 * approval policy queues the destructive class for the operator whatever the configuration says,
 * and `tenant.remove` refuses a tenant that still holds sites and never purges state. Removing a
 * site stays a decision made at the box, and a command that asks for it is answered with a typed
 * refusal rather than silence.
 */
export function fleetExecutors(ctx: Context, globals: Globals, runtime?: Runtime): Executors {
	function setSuspended(ref: string, suspended: boolean): Promise<ExecResult> {
		return onTenant(ref, async (tenant) => {
			try {
				setTenantSuspended(ctx, globals, tenant.name, suspended);
			} catch (error) {
				if (error instanceof BastionError) return { ok: false, code: error.code };
				throw error;
			}
			if (runtime === undefined) return { ok: true, code: null };
			const outcome = await runtime.reload([tenant.name]);
			return outcome.failed.some((entry) => entry.tenant === tenant.name)
				? { ok: false, code: 'reload_failed' }
				: { ok: true, code: null };
		});
	}

	// the tenant a command names: its name, or the digest this box shows when it hashes names
	function findTenant(config: Loaded['config'], ref: string): TenantConfig | null {
		const exact = config.tenants.find((entry) => entry.name === ref);
		if (exact !== undefined || !ref.startsWith('h:')) return exact ?? null;
		const nodeId = new PairStore(ctx, config.state).record()?.nodeId;
		if (nodeId === undefined) return null;
		return config.tenants.find((entry) => nameOf(entry.name, nodeId, true) === ref) ?? null;
	}

	function refParams(raw: Record<string, unknown>): Record<string, string> {
		only(raw, ['name']);
		return { name: text(raw, 'name', TENANT_REF) };
	}

	async function onTenant(
		ref: string,
		act: (tenant: TenantConfig, config: Loaded['config']) => Promise<ExecResult>
	): Promise<ExecResult> {
		const { config } = load(ctx, globals);
		const tenant = findTenant(config, ref);
		if (tenant === null) return { ok: false, code: 'unknown_tenant' };
		return act(tenant, config);
	}

	// a site already on this host counts as the same one when it points at the same path, or at a
	// file whose digest is the one the command carries
	function sameBundle(held: string, params: Record<string, string>): boolean {
		if (held === params.bundle) return true;
		if (params.checksum === undefined || !ctx.files.exists(held)) return false;
		return `sha256:${sha256Of(ctx.files.readBytes(held))}` === params.checksum;
	}

	return {
		'health.observe': {
			class: 'safe',
			params: (raw) => {
				only(raw, []);
				return {};
			},
			run: async () => {
				const outcome = await cli(ctx, globals, ['health']);
				return { ok: outcome.ok, code: outcome.code };
			}
		},
		'tenant.reload': {
			class: 'rebuild',
			params: (raw) => {
				only(raw, []);
				return {};
			},
			run: async () => {
				const outcome = await cli(ctx, globals, ['reload']);
				return { ok: outcome.ok, code: outcome.code };
			}
		},
		'site.deploy': {
			class: 'rebuild',
			params: (raw) => {
				only(raw, ['host', 'bundle', 'checksum']);
				const bundle = raw.bundle;
				if (
					typeof bundle !== 'string' ||
					!(BUNDLE_URL.test(bundle) || BUNDLE_PATH.test(bundle))
				) {
					throw new ParamError('bundle is not acceptable');
				}
				const checksum = text(raw, 'checksum', CHECKSUM, true);
				return {
					host: text(raw, 'host', HOST),
					bundle,
					...(checksum === '' ? {} : { checksum })
				};
			},
			run: async (params) => {
				const outcome = await cli(ctx, globals, [
					'deploy',
					params.host as string,
					params.bundle as string,
					...(params.checksum === undefined ? [] : ['--checksum', params.checksum])
				]);
				return {
					ok: outcome.ok,
					code: outcome.code,
					deploy: outcome.ok ? deployed(outcome) : null
				};
			}
		},
		'site.add': {
			class: 'stateful',
			params: (raw) => {
				only(raw, ['host', 'bundle', 'checksum', 'tenant']);
				const bundle = raw.bundle;
				if (
					typeof bundle !== 'string' ||
					!(BUNDLE_URL.test(bundle) || BUNDLE_PATH.test(bundle))
				) {
					throw new ParamError('bundle is not acceptable');
				}
				const checksum = text(raw, 'checksum', CHECKSUM, true);
				const tenant = text(raw, 'tenant', TENANT_REF, true);
				return {
					host: text(raw, 'host', HOST),
					bundle,
					...(checksum === '' ? {} : { checksum }),
					...(tenant === '' ? {} : { tenant })
				};
			},
			run: async (params) => {
				const loaded = load(ctx, globals);
				const host = params.host as string;
				const held = loaded.config.tenants
					.flatMap((tenant) => tenant.sites)
					.find((site) => site.host === host);
				if (held !== undefined) {
					return sameBundle(held.bundle, params)
						? { ok: true, code: null }
						: { ok: false, code: 'site_exists' };
				}
				// a box with no tenant is refused: a tenant carries limits and egress the operator sets.
				// With no tenant named, the only tenant is used; two or more are never guessed between
				const { tenants } = loaded.config;
				if (params.tenant === undefined && tenants.length === 0) {
					return { ok: false, code: 'no_tenant' };
				}
				if (params.tenant === undefined && tenants.length > 1) {
					return { ok: false, code: 'ambiguous_tenant' };
				}
				const chosen =
					params.tenant === undefined
						? tenants[0]!
						: findTenant(loaded.config, params.tenant);
				if (chosen === null) return { ok: false, code: 'unknown_tenant' };
				const tenant = chosen.name;
				// the ceiling is checked before the bundle is fetched, so a full tenant downloads nothing
				try {
					admitSite(
						chosen.sites.length,
						capacity(
							readHost(ctx, loaded.state),
							defaultCostModel(loaded.config.mode),
							{
								residency: loaded.config.runtime.residency,
								tenants: Math.max(1, tenants.length)
							}
						),
						chosen.limits?.maxSites
					);
				} catch (error) {
					if (error instanceof BastionError) return { ok: false, code: error.code };
					throw error;
				}
				// fetched and unpacked here, before the command writes anything: a bundle that
				// would only fail at the next reload is refused now, with no config written. The
				// command then takes the local file, so nothing downloads twice
				const dest = `${loaded.config.state}/bundles/${host}`;
				let bundle: string;
				let prepared: PreparedBundle;
				try {
					const pulled = await pullBundle(ctx, params.bundle as string, {
						dest,
						...downloadOptions({ checksum: params.checksum })
					});
					prepared = await prepareBundle(ctx, pulled.path, `${dest}/.check`);
					bundle = pulled.path;
				} catch (error) {
					if (error instanceof BastionError) return { ok: false, code: error.code };
					throw error;
				}
				// the runtime serves one site per tenant out of one assets folder, so a tenant that
				// already holds a site keeps its own files
				const holds = chosen.sites;
				let install: AssetInstall | null = null;
				try {
					if (prepared.assets !== null && holds.length === 0) {
						install = installAssets(
							ctx,
							prepared.assets.dir,
							tenantAssets(loaded.config.state, tenant),
							prepared.assets.files
						);
					}
					const outcome = await cli(ctx, globals, [
						'site',
						'add',
						host,
						'--tenant',
						tenant,
						'--bundle',
						bundle,
						...(prepared.varsFile === null ? [] : ['--vars-file', prepared.varsFile])
					]);
					if (outcome.ok) install?.commit();
					else install?.rollback();
					return { ok: outcome.ok, code: outcome.code };
				} catch (error) {
					install?.rollback();
					if (error instanceof BastionError) return { ok: false, code: error.code };
					throw error;
				} finally {
					prepared.discard();
				}
			}
		},
		'site.rollback': {
			class: 'stateful',
			params: (raw) => {
				only(raw, ['host', 'version']);
				const version = text(raw, 'version', VERSION_ID, true);
				return { host: text(raw, 'host', HOST), ...(version === '' ? {} : { version }) };
			},
			run: async (params) => {
				const outcome = await cli(ctx, globals, [
					'rollback',
					params.host as string,
					...(params.version === undefined ? [] : ['--to', params.version])
				]);
				return {
					ok: outcome.ok,
					code: outcome.code,
					deploy: outcome.ok ? deployed(outcome) : null
				};
			}
		},
		'backup.now': {
			class: 'stateful',
			params: (raw) => {
				only(raw, ['site']);
				const site = text(raw, 'site', HOST, true);
				const params: Record<string, string> = {};
				if (site !== '') params.site = site;
				return params;
			},
			run: async (params) => {
				const outcome = await cli(ctx, globals, [
					'backup',
					'now',
					...(params.site === undefined ? [] : ['--site', params.site])
				]);
				return { ok: outcome.ok, code: outcome.code };
			}
		},
		'tenant.add': {
			class: 'stateful',
			params: (raw) => {
				only(raw, ['name', 'maxSites']);
				const maxSites = count(raw, 'maxSites', 100_000);
				return {
					name: text(raw, 'name', TENANT),
					...(maxSites === null ? {} : { maxSites: String(maxSites) })
				};
			},
			run: async (params) => {
				const { config } = load(ctx, globals);
				const held = config.tenants.find((entry) => entry.name === params.name);
				if (held !== undefined) {
					// the same name with the same ceiling is a resend that already happened
					const same = String(held.limits?.maxSites ?? '') === (params.maxSites ?? '');
					return same ? { ok: true, code: null } : { ok: false, code: 'tenant_exists' };
				}
				const outcome = await cli(ctx, globals, [
					'tenant',
					'add',
					params.name!,
					...(params.maxSites === undefined ? [] : ['--max-sites', params.maxSites])
				]);
				return { ok: outcome.ok, code: outcome.code };
			}
		},
		'tenant.remove': {
			class: 'destructive',
			params: refParams,
			run: (params) =>
				onTenant(params.name!, async (tenant) => {
					// sites are removed one by one at the box; a tenant that holds any keeps them
					if (tenant.sites.length > 0) return { ok: false, code: 'tenant_not_empty' };
					const outcome = await cli(ctx, globals, ['tenant', 'rm', tenant.name]);
					return { ok: outcome.ok, code: outcome.code };
				})
		},
		// the flag is written by the function the box's own command calls, then the running process
		// reloads that tenant, as the management API does. Without a running process (a spec, or a
		// box not serving) the flag alone is written and takes effect when it starts
		'tenant.suspend': {
			class: 'stateful',
			params: refParams,
			run: (params) => setSuspended(params.name!, true)
		},
		'tenant.resume': {
			class: 'stateful',
			params: refParams,
			run: (params) => setSuspended(params.name!, false)
		},
		'tenant.limits': {
			class: 'stateful',
			params: (raw) => {
				only(raw, ['name', 'maxSites', 'cpu', 'memory', 'pids']);
				const maxSites = count(raw, 'maxSites', 100_000);
				const pids = count(raw, 'pids', 4_194_304);
				const cpu = text(raw, 'cpu', CPU, true);
				const memory = text(raw, 'memory', MEMORY, true);
				const params = {
					name: text(raw, 'name', TENANT_REF),
					...(maxSites === null ? {} : { maxSites: String(maxSites) }),
					...(pids === null ? {} : { pids: String(pids) }),
					...(cpu === '' ? {} : { cpu }),
					...(memory === '' ? {} : { memory })
				};
				// a command with nothing to set would only read the limits back
				if (Object.keys(params).length === 1) throw new ParamError('no limit is named');
				return params;
			},
			run: (params) =>
				onTenant(params.name!, async (tenant) => {
					if (
						params.maxSites !== undefined &&
						tenant.sites.length > Number(params.maxSites)
					) {
						return { ok: false, code: 'below_site_count' };
					}
					const outcome = await cli(ctx, globals, [
						'tenant',
						'limits',
						tenant.name,
						...(params.cpu === undefined ? [] : ['--cpu', params.cpu]),
						...(params.memory === undefined ? [] : ['--memory', params.memory]),
						...(params.pids === undefined ? [] : ['--pids', params.pids]),
						...(params.maxSites === undefined ? [] : ['--max-sites', params.maxSites])
					]);
					return { ok: outcome.ok, code: outcome.code };
				})
		}
	};
}

/**
 * The link `serve` holds, built from the box's own configuration.
 *
 * Constructing it opens nothing: the link dials only once a pairing record exists, so a box that
 * never paired runs exactly as it did before.
 */
export function startFleetLink(ctx: Context, globals: Globals, runtime?: Runtime): FleetLink {
	const loaded = load(ctx, globals);
	return new FleetLink({
		ctx,
		config: loaded.config,
		state: loaded.state,
		secrets: buildSecrets(ctx, loaded.config.drivers.secrets),
		executors: fleetExecutors(ctx, globals, runtime),
		reread: () => {
			try {
				return load(ctx, globals).config;
			} catch {
				return null;
			}
		},
		...(runtime === undefined ? {} : { analytics: runtime.analytics }),
		...(loaded.config.pairing?.sendHostname === true ? { hostname: hostname() } : {})
	});
}

export { BastionError };
