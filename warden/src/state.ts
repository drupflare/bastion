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

/** prints the object under `--json` and the rendered text otherwise, never both */
export function emit(ctx: Context, globals: Globals, payload: unknown, text: () => string): void {
	if (globals.json === true) {
		ctx.io.out(JSON.stringify(payload));
		return;
	}
	if (globals.quiet === true) return;
	ctx.io.out(text());
}
