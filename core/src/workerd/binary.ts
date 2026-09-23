import { createHash } from 'node:crypto';
import type { Context } from '../context';
import { BastionError } from '../errors';
import { requireFloor } from './version';

/**
 * Flags bastion must never pass to workerd.
 *
 * `--debug-port` is described by workerd's own help as "a privileged interface that allows access
 * to all services in the process. For use by miniflare and local development only", and unlike the
 * matching binding it is NOT gated behind `--experimental`. `--inspector-addr` is a v8 inspector
 * with full isolate access. Either one on a multi-tenant host hands every tenant to whoever can
 * reach the port.
 */
export const FORBIDDEN_FLAGS = ['--debug-port', '--inspector-addr'] as const;

/** raises when an argv carries a flag that must never reach workerd */
export function assertArgvSafe(argv: readonly string[]): void {
	for (const arg of argv) {
		const flag = arg.split('=')[0] ?? arg;
		if ((FORBIDDEN_FLAGS as readonly string[]).includes(flag)) {
			throw new BastionError(
				'capability-refused',
				`${flag} exposes every service in the process and is never passed`
			);
		}
	}
}

export interface WorkerdPin {
	version: string;
	/** sha256 of the binary itself, which is what is actually pinned */
	digest?: string;
}

export interface ResolvedBinary {
	path: string;
	version: string;
	digest: string;
}

export function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** where a pinned binary is cached under the state directory */
export function binaryPath(state: string, version: string): string {
	return `${state.replace(/\/+$/, '')}/runtime/workerd-${version}`;
}

/** where the digest of a staged binary is kept, beside the binary it describes */
export function digestPath(binary: string): string {
	return `${binary}.sha256`;
}

/**
 * What this binary hashed when bastion first saw it, or null the first time.
 *
 * bastion ships no manifest of published digests, so what `verify: sha256` can honestly promise is
 * that the binary running today is the one that was staged: a swap on disk after install is
 * caught. It is not a check on the download itself, and the manual says so.
 */
export function recordedDigest(ctx: Context, binary: string): string | null {
	const path = digestPath(binary);
	return ctx.files.exists(path) ? ctx.files.readText(path).trim() : null;
}

/**
 * Resolves the pinned workerd, verifying its digest and its floor.
 *
 * The digest is the pin; the version string is a label. Two releases can carry one tag across a
 * rebuild, so checking the tag alone verifies nothing about the bytes that will execute.
 */
export function resolveBinary(
	ctx: Context,
	options: {
		state: string;
		pin: WorkerdPin;
		floor: string;
		verify: 'sha256' | 'none';
		forceBelowFloor?: boolean;
	}
): ResolvedBinary {
	const verdict = requireFloor(
		'workerd',
		options.pin.version,
		options.floor,
		options.forceBelowFloor === true
	);
	const path = binaryPath(options.state, options.pin.version);
	if (!ctx.files.exists(path)) {
		throw new BastionError('workerd-missing', `no workerd ${options.pin.version} at ${path}`);
	}
	const digest = sha256(ctx.files.readBytes(path));
	if (options.verify === 'sha256') {
		// the configured digest wins when there is one. Without it this verified nothing at all:
		// no manifest ships, the caller passed only a version, so `verify: sha256` read as a
		// control and compared a value against undefined on every start
		const expected = options.pin.digest ?? recordedDigest(ctx, path);
		if (expected === null) {
			// first sight of this binary: record what it hashes, so a later swap is detectable
			ctx.files.writeText(digestPath(path), `${digest}\n`);
		} else if (digest !== expected) {
			throw new BastionError(
				'workerd-digest',
				`workerd at ${path} hashes ${digest}, expected ${expected}`,
				{ next: 'bastion update apply' }
			);
		}
	}
	if (!verdict.ok && options.forceBelowFloor === true) {
		// accepted, never silent: the CVE is named wherever this lands
		ctx.io.err(`warning: ${verdict.message}`);
	}
	return { path, version: options.pin.version, digest };
}

/** the argv for `workerd serve`, after the safety check */
export function serveArgv(configPath: string, extra: readonly string[] = []): string[] {
	const argv = ['serve', configPath, ...extra];
	assertArgvSafe(argv);
	return argv;
}
