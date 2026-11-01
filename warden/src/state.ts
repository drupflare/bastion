import type { BackupOptions, BastionConfig, Context } from '@drupflare/bastion';
import { BastionError, loadConfig } from '@drupflare/bastion';

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

/** the backup key from the environment; the engine refuses only the read or write that needs it */
export function backupOptions(ctx: Context): BackupOptions {
	const passphrase = ctx.env.BASTION_BACKUP_KEY;
	return passphrase === undefined ? {} : { passphrase };
}

/**
 * The backup key for a command that writes a pack, refused before it copies a database.
 *
 * Without this a `backup now` with no key captures the database into staging and only then has the
 * engine refuse the write.
 */
export function requireBackupOptions(ctx: Context): BackupOptions {
	const options = backupOptions(ctx);
	if (options.passphrase === undefined || options.passphrase === '') {
		throw new BastionError(
			'capability-refused',
			'backups are encrypted; set BASTION_BACKUP_KEY in the environment bastion runs in'
		);
	}
	return options;
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
