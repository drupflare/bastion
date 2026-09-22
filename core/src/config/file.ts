import { isAbsolute, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { BastionError, UsageError } from '../errors';
import type { FileHost } from '../host/files';
import { defaultConfig } from './defaults';
import schema from './schema.json' with { type: 'json' };
import type { BastionConfig } from './types';
import { validate, type Problem, type ValidationResult } from './validate';

export const CONFIG_NAME = 'bastion.yml';

/** where a resolved value came from, so a report never presents an inference as an instruction */
export type SettingOrigin = 'flag' | 'env' | 'file' | 'default';

export interface Setting<T = string> {
	value: T;
	origin: SettingOrigin;
	/** the flag, the environment variable or the file path that supplied it */
	from: string;
}

export interface LoadedConfig {
	config: BastionConfig;
	/** the file it came from, or null when nothing was on disk */
	path: string | null;
	/** every key the file set, dotted, so `config where` can attribute each one */
	origins: Map<string, Setting<unknown>>;
}

export interface ConfigHost {
	files: FileHost;
	env: NodeJS.ProcessEnv;
	cwd: string;
}

/** `$BASTION_CONFIG`, then `./bastion.yml`, then `/etc/bastion/bastion.yml` */
export function configPath(host: ConfigHost, override?: string): string {
	if (override !== undefined && override !== '') {
		return isAbsolute(override) ? override : resolve(host.cwd, override);
	}
	const fromEnv = host.env.BASTION_CONFIG?.trim();
	if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
	const local = resolve(host.cwd, CONFIG_NAME);
	if (host.files.exists(local)) return local;
	return `/etc/bastion/${CONFIG_NAME}`;
}

/**
 * Reads and validates a file WITHOUT merging defaults, for `config validate`.
 *
 * Parsing lives here rather than in the CLI so there is one YAML reader and one set of rules; a
 * second parse in the command layer is how two answers to "is this file valid" appear.
 */
export function validateFile(
	host: ConfigHost,
	options: { path?: string; testLane?: boolean } = {}
): { path: string; result: ValidationResult } {
	const path = configPath(host, options.path);
	if (!host.files.exists(path)) throw new UsageError(`no config file at ${path}`);
	let parsed: unknown;
	try {
		parsed = parseYaml(host.files.readText(path));
	} catch (e) {
		throw new UsageError(
			`${path} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`
		);
	}
	return { path, result: validate(parsed, { testLane: options.testLane === true }) };
}

/** the JSON Schema an editor completes from; one copy, read through the package */
export function schemaText(): string {
	return JSON.stringify(schema, null, '\t');
}

/** renders problems as one message, most specific path first */
export function describeProblems(problems: Problem[]): string {
	return problems.map((p) => (p.path === '' ? p.message : `${p.path}: ${p.message}`)).join('\n');
}

/**
 * Reads and validates one config file.
 *
 * **An unparseable file is an error, never an absent one.** Treating a broken `bastion.yml` as no
 * config would silently drop every setting in it and send the operator hunting for a flag they
 * already set.
 */
export function loadConfig(
	host: ConfigHost,
	options: { path?: string; required?: boolean; testLane?: boolean } = {}
): LoadedConfig {
	const path = configPath(host, options.path);
	if (!host.files.exists(path)) {
		if (options.required === true) {
			throw new BastionError('config-missing', `no ${CONFIG_NAME} at ${path}`);
		}
		return { config: defaultConfig(), path: null, origins: new Map() };
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(host.files.readText(path));
	} catch (e) {
		throw new UsageError(
			`${path} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`
		);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new UsageError(`${path} must hold a mapping`);
	}

	const result = validate(parsed, { testLane: options.testLane === true });
	if (!result.ok) {
		throw new BastionError('config-invalid', `${path}\n${describeProblems(result.problems)}`);
	}

	const origins = new Map<string, Setting<unknown>>();
	collectOrigins(parsed as Record<string, unknown>, '', path, origins);
	return { config: merge(defaultConfig(), parsed as Record<string, unknown>), path, origins };
}

/** records every key the FILE set; anything absent from this map came from a default */
function collectOrigins(
	node: Record<string, unknown>,
	prefix: string,
	path: string,
	into: Map<string, Setting<unknown>>
): void {
	for (const [key, value] of Object.entries(node)) {
		const dotted = prefix === '' ? key : `${prefix}.${key}`;
		into.set(dotted, { value, origin: 'file', from: path });
		if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
			collectOrigins(value as Record<string, unknown>, dotted, path, into);
		}
	}
}

/** a mapping merges key by key; a list replaces, because a partial list is never what was meant */
function merge<T>(base: T, over: Record<string, unknown>): T {
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(over)) {
		const existing = out[key];
		if (
			value !== null &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			existing !== null &&
			typeof existing === 'object' &&
			!Array.isArray(existing)
		) {
			out[key] = merge(existing, value as Record<string, unknown>);
		} else {
			out[key] = value;
		}
	}
	return out as T;
}

/**
 * Writes a configuration back, through the same validator a read uses.
 *
 * The CLI and the dashboard editor both call this, which is what stops the two disagreeing about
 * what a valid file is. A configuration that does not validate is refused here rather than written
 * and rejected on the next start.
 */
export function writeConfig(host: ConfigHost, path: string, config: BastionConfig): string {
	const problems = validate(config);
	if (!problems.ok) {
		throw new BastionError('config-invalid', describeProblems(problems.problems), {
			next: 'bastion config validate'
		});
	}
	host.files.writeText(path, stringifyYaml(config));
	return path;
}

/** the backup target, defaulting to local disk rather than to nothing */
export function backupTarget(config: BastionConfig): { driver: string; [key: string]: unknown } {
	const target = (config.backup as { target?: Record<string, unknown> } | undefined)?.target;
	if (target === undefined || typeof target.driver !== 'string') return { driver: 'fs' };
	return target as { driver: string; [key: string]: unknown };
}
