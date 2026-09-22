import type { Context } from '../context';
import { BastionError } from '../errors';

export type CaptureMethod = 'vacuum-into' | 'online-backup' | 'quiesced-copy';

export interface CaptureResult {
	method: CaptureMethod;
	path: string;
	bytes: number;
}

/**
 * How a live Durable Object database is captured.
 *
 * **A byte-wise copy of an open SQLite with a hot WAL is corrupt, silently.** workerd writes
 * `<id>.sqlite` plus `-wal` and `-shm`, so reading the first file alone gives a database missing
 * every committed page still in the log, and the framing pipeline downstream cannot tell.
 *
 * So a capture is a real step with three methods in preference order, and the one used is recorded
 * with the backup rather than assumed:
 *
 * - `vacuum-into` where the database is reachable: SQLite writes a consistent copy itself.
 * - `online-backup` where a connection can be opened but `VACUUM INTO` cannot run.
 * - `quiesced-copy` as the fallback: stop the tenant, copy, start it. Correct and disruptive, which
 *   is why it is last rather than absent.
 */
export function captureMethods(): CaptureMethod[] {
	return ['vacuum-into', 'online-backup', 'quiesced-copy'];
}

export interface CaptureOptions {
	/** the live database */
	source: string;
	/** where the consistent copy goes */
	staging: string;
	/** opens a connection and runs `VACUUM INTO`; absent where the database is not reachable */
	vacuumInto?(source: string, destination: string): void;
	/** SQLite's online backup API */
	onlineBackup?(source: string, destination: string): void;
	/** stops and restarts the tenant around a plain copy */
	quiesce?(run: () => void): Promise<void>;
}

export async function capture(ctx: Context, options: CaptureOptions): Promise<CaptureResult> {
	if (!ctx.files.exists(options.source)) {
		throw new BastionError('usage', `${options.source} is not there`);
	}

	if (options.vacuumInto !== undefined) {
		options.vacuumInto(options.source, options.staging);
		return {
			method: 'vacuum-into',
			path: options.staging,
			bytes: ctx.files.size(options.staging)
		};
	}

	if (options.onlineBackup !== undefined) {
		options.onlineBackup(options.source, options.staging);
		return {
			method: 'online-backup',
			path: options.staging,
			bytes: ctx.files.size(options.staging)
		};
	}

	if (options.quiesce !== undefined) {
		await options.quiesce(() => {
			ctx.files.writeBytes(options.staging, ctx.files.readBytes(options.source));
			// the log travels with the database; copying one without the other is the corruption
			for (const suffix of ['-wal', '-shm']) {
				const side = `${options.source}${suffix}`;
				if (ctx.files.exists(side)) {
					ctx.files.writeBytes(`${options.staging}${suffix}`, ctx.files.readBytes(side));
				}
			}
		});
		return {
			method: 'quiesced-copy',
			path: options.staging,
			bytes: ctx.files.size(options.staging)
		};
	}

	throw new BastionError(
		'driver-refused',
		'a live database cannot be captured by a plain copy: the WAL holds committed pages the ' +
			'file does not, and the result would be corrupt with nothing reporting it'
	);
}
