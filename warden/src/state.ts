import type { BastionConfig, Context } from '@drupflare/bastion';
import { loadConfig } from '@drupflare/bastion';

export interface Globals {
	config?: string;
	profile?: string;
	json?: boolean;
	verbose?: boolean;
	quiet?: boolean;
	yes?: boolean;
}

export interface Loaded {
	config: BastionConfig;
	path: string | null;
	/** where bastion keeps everything it writes */
	state: string;
}

export function load(ctx: Context, globals: Globals): Loaded {
	const loaded = loadConfig(ctx, globals.config === undefined ? {} : { path: globals.config });
	return { config: loaded.config, path: loaded.path, state: loaded.config.state };
}

/**
 * Where a command that changes the configuration writes it.
 *
 * `--config` wins over the working directory, which it did not before: a writer that fell back to
 * `${cwd}/bastion.yml` whenever the named file did not yet exist would take
 * `tenant add acme --config /etc/bastion/prod.yml`, write `./bastion.yml` instead, and report
 * success naming the path it actually used. An operator who thought they had edited production had
 * edited whatever directory they were standing in, and the next command read the production file
 * back without their change.
 */
export function writePath(ctx: Context, globals: Globals, loaded: Loaded): string {
	return loaded.path ?? globals.config ?? `${ctx.cwd}/bastion.yml`;
}

/** prints the object under `--json` and the rendered text otherwise, never both */
export function emit(ctx: Context, globals: Globals, payload: unknown, text: () => string): void {
	if (globals.json === true) {
		ctx.io.out(JSON.stringify(payload));
		return;
	}
	if (globals.quiet === true) return;
	ctx.io.out(text());
}
