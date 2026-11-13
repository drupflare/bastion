import type { Context, Executors, Runtime } from '@drupflare/bastion';
import {
	BastionError,
	EXIT,
	FleetLink,
	ParamError,
	buildSecrets,
	memoryIo
} from '@drupflare/bastion';
import { hostname } from 'node:os';
import { run } from './run';
import { load, type Globals } from './state';

const HOST = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHECKSUM = /^sha256:[0-9a-f]{64}$/;
const BUNDLE_URL = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~%/+=-]*$/;
const BUNDLE_PATH = /^\/[A-Za-z0-9._/-]{1,512}$/;

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
 * Five actions, each an existing command. There is nothing in the destructive class: removing a
 * site or a tenant stays a decision made at the box, and a command that asks for it is answered
 * with a typed refusal rather than silence.
 */
export function fleetExecutors(ctx: Context, globals: Globals): Executors {
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
		executors: fleetExecutors(ctx, globals),
		...(runtime === undefined ? {} : { analytics: runtime.analytics }),
		...(loaded.config.pairing?.sendHostname === true ? { hostname: hostname() } : {})
	});
}

export { BastionError };
