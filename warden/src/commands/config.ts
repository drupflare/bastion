import {
	describeProblems,
	loadConfig,
	schemaText,
	UsageError,
	validateFile,
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
