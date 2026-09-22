import {
	BastionError,
	describeProblems,
	loadConfig,
	schemaText,
	UsageError,
	validateFile,
	writeConfig,
	type Context
} from '@drupflare/bastion';
import { kv, table } from '../format';

export interface ConfigOptions {
	json?: boolean;
	config?: string;
}

export function runConfigShow(ctx: Context, options: ConfigOptions = {}): void {
	const loaded = loadConfig(ctx, { path: options.config });
	if (options.json === true) {
		ctx.io.out(JSON.stringify(loaded.config));
		return;
	}
	ctx.io.out(JSON.stringify(loaded.config, null, '\t'));
}

/** every resolved value and what supplied it; the answer to "why is it picking that" */
export function runConfigWhere(ctx: Context, options: ConfigOptions = {}): void {
	const loaded = loadConfig(ctx, { path: options.config });
	const rows = [...loaded.origins.entries()]
		.filter(([, setting]) => typeof setting.value !== 'object' || setting.value === null)
		.map(([key, setting]) => [key, String(setting.value), setting.origin, setting.from])
		.sort((a, b) => (a[0] as string).localeCompare(b[0] as string));

	if (options.json === true) {
		ctx.io.out(
			JSON.stringify({
				path: loaded.path,
				settings: rows.map(([key, value, origin, from]) => ({ key, value, origin, from }))
			})
		);
		return;
	}
	ctx.io.out(kv([['config', loaded.path ?? '(defaults; no file)']]));
	ctx.io.out('');
	// anything absent here came from a default, which is itself the answer
	ctx.io.out(table(['key', 'value', 'origin', 'from'], rows as string[][]));
}

export function runConfigValidate(ctx: Context, options: ConfigOptions = {}): void {
	const { path, result } = validateFile(ctx, {
		...(options.config === undefined ? {} : { path: options.config }),
		testLane: ctx.env.BASTION_TEST === '1'
	});
	if (options.json === true) {
		ctx.io.out(JSON.stringify({ ok: result.ok, path, problems: result.problems }));
		if (!result.ok) throw new UsageError(`${path} has ${result.problems.length} problems`);
		return;
	}
	if (result.ok) {
		ctx.io.out(`${path} is valid`);
		return;
	}
	ctx.io.err(describeProblems(result.problems));
	throw new UsageError(`${path} has ${result.problems.length} problems`);
}

export function runConfigSchema(ctx: Context): void {
	ctx.io.out(schemaText());
}

/** walks a dotted path, so `bastion config get runtime.residency` reads one value */
export function valueAt(config: unknown, key: string): unknown {
	let at: unknown = config;
	for (const part of key.split('.')) {
		if (at === null || typeof at !== 'object') return undefined;
		at = (at as Record<string, unknown>)[part];
	}
	return at;
}

export function runConfigGet(ctx: Context, options: ConfigOptions, key: string): void {
	const loaded = loadConfig(ctx, { path: options.config });
	const value = valueAt(loaded.config, key);
	if (value === undefined) {
		throw new BastionError('usage', `${key} is not set`, { next: 'bastion config show' });
	}
	if (options.json === true) {
		ctx.io.out(JSON.stringify({ key, value }));
		return;
	}
	ctx.io.out(typeof value === 'object' ? JSON.stringify(value, null, '\t') : String(value));
}

/**
 * Types a value the way the schema does, so `maxSites 40` is a number and not the string "40".
 *
 * A quoted value is always a string, which is the escape hatch for a port or a version that must
 * not be coerced.
 */
export function coerce(raw: string): unknown {
	if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	if (raw === 'null') return null;
	if (raw !== '' && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
	if (raw.startsWith('[') || raw.startsWith('{')) {
		try {
			return JSON.parse(raw);
		} catch {
			return raw;
		}
	}
	return raw;
}

function withValue(config: unknown, key: string, value: unknown): unknown {
	const [head, ...rest] = key.split('.');
	if (head === undefined) return value;
	const base = (config ?? {}) as Record<string, unknown>;
	return {
		...base,
		[head]: rest.length === 0 ? value : withValue(base[head], rest.join('.'), value)
	};
}

/** writes through the same validator the dashboard uses, so the two cannot disagree */
export function runConfigSet(ctx: Context, options: ConfigOptions, key: string, raw: string): void {
	const loaded = loadConfig(ctx, { path: options.config });
	const next = withValue(loaded.config, key, coerce(raw)) as typeof loaded.config;
	const path = writeConfig(ctx, loaded.path ?? `${ctx.cwd}/bastion.yml`, next);
	const value = valueAt(next, key);
	if (options.json === true) {
		ctx.io.out(JSON.stringify({ key, value, path }));
		return;
	}
	ctx.io.out(
		kv([
			['set', key],
			['to', typeof value === 'object' ? JSON.stringify(value) : String(value)],
			['in', path]
		])
	);
}

/**
 * Opens the file in `$EDITOR` and validates what comes back.
 *
 * The validation is the point: an editor that saved something the loader refuses would otherwise
 * be discovered on the next start, which is the worst moment to find out.
 */
export async function runConfigEdit(ctx: Context, options: ConfigOptions = {}): Promise<void> {
	const loaded = loadConfig(ctx, { path: options.config });
	const path = loaded.path ?? `${ctx.cwd}/bastion.yml`;
	const editor = ctx.env.EDITOR ?? ctx.env.VISUAL;
	if (editor === undefined || editor === '') {
		throw new BastionError('usage', 'set $EDITOR to the editor you want', {
			next: 'bastion config set <key> <value>'
		});
	}

	// spawn rather than run, because an editor owns the terminal for as long as it is open
	const code = await ctx.runner.spawn(editor, [path]).exited;
	if (code !== 0) {
		throw new BastionError('usage', `${editor} exited ${code}; nothing was validated`);
	}

	const { result } = validateFile(ctx, {
		...(options.config === undefined ? {} : { path: options.config }),
		testLane: ctx.env.BASTION_TEST === '1'
	});
	if (!result.ok) {
		throw new BastionError('config-invalid', describeProblems(result.problems), {
			next: 'bastion config validate'
		});
	}
	if (options.json === true) {
		ctx.io.out(JSON.stringify({ path, ok: true }));
		return;
	}
	ctx.io.out(`${path} is valid`);
}
