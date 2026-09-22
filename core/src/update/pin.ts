import { createHash } from 'node:crypto';
import { FLOOR_REASONS, VERSION_FLOORS } from '../config/defaults';
import type { Context } from '../context';
import { BastionError } from '../errors';
import { compareWorkerd } from '../workerd/version';

export interface Pin {
	version: string;
	sha256: string;
	/** the on-disk layout the Durable Object storage uses under this pin */
	storageFormat: string;
	url?: string;
}

/**
 * The storage format each workerd pin writes.
 *
 * `localDisk` is marked EXPERIMENTAL and SUBJECT TO BACKWARDS-INCOMPATIBLE CHANGE in the schema,
 * and the code does not gate it behind `--experimental` -- so it works today and the risk is that
 * the layout changes under a version bump. A rollback across a format change is not a rollback,
 * which is why the fingerprint is recorded per pin rather than assumed constant.
 */
export const FORMAT_FINGERPRINTS: Record<string, string> = {
	'v1.20231121.0': 'sqlite-v1',
	'v1.20260828.1': 'sqlite-v1'
};

export function formatFor(version: string): string {
	return FORMAT_FINGERPRINTS[version] ?? FORMAT_FINGERPRINTS[`v${version}`] ?? 'unknown';
}

export function sha256Of(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Verifies a downloaded binary against the pin.
 *
 * By binary sha256 rather than by tag: a tag is a mutable pointer at a release someone else owns,
 * and the whole reason a pin exists is that the bytes are the same ones that were tested.
 */
export function verifyBinary(ctx: Context, path: string, pin: Pin): void {
	if (!ctx.files.exists(path)) {
		throw new BastionError('workerd-missing', `${path} is not there`);
	}
	const actual = sha256Of(ctx.files.readBytes(path));
	if (actual !== pin.sha256) {
		throw new BastionError(
			'workerd-digest',
			`${path} hashes to ${actual.slice(0, 16)} and the pin says ${pin.sha256.slice(0, 16)}`
		);
	}
}

export interface ChangeRefusal {
	ok: boolean;
	reasons: string[];
}

/**
 * The two refusals in front of a pin change.
 *
 * Below the CVE floor, and across a storage format change. Each names what it is protecting rather
 * than exiting with a number: `--force-below-floor` states which CVE is being accepted, and a
 * format change needs `--restore-from <backup>` because there is nothing else that makes the old
 * pin able to read the new pin's data.
 */
export function checkPinChange(
	from: Pin | null,
	to: Pin,
	options: {
		forceBelowFloor?: boolean;
		restoreFrom?: string;
		verifiedBackup?: boolean;
		floor?: string;
	} = {}
): ChangeRefusal {
	const reasons: string[] = [];
	const floor = options.floor ?? VERSION_FLOORS.workerd;

	const against = compareWorkerd(to.version, floor);
	if (against === null) {
		// an unreadable version is refused rather than let through: "cannot tell" and "clears the
		// floor" are different answers, and only one of them is safe to act on
		reasons.push(
			`${to.version} does not parse as a workerd version, so it cannot be compared to ${floor}`
		);
	} else if (against < 0 && options.forceBelowFloor !== true) {
		reasons.push(
			`${to.version} is below the floor ${floor}, which closes ${FLOOR_REASONS.workerd}`
		);
	}

	if (from !== null && from.storageFormat !== to.storageFormat) {
		const covered = options.restoreFrom !== undefined && options.verifiedBackup === true;
		if (!covered) {
			reasons.push(
				`the storage format changes from ${from.storageFormat} to ${to.storageFormat}. ` +
					'A rollback across that is not a rollback: pass --restore-from <backup> with a ' +
					'backup that has been verified'
			);
		}
	}

	return { ok: reasons.length === 0, reasons };
}

export function acceptedCves(to: Pin, floor: string = VERSION_FLOORS.workerd): string[] {
	const against = compareWorkerd(to.version, floor);
	const reason = FLOOR_REASONS.workerd;
	return against !== null && against < 0 && reason !== undefined ? [reason] : [];
}

export interface RolloutStep {
	tenant: string;
	order: number;
	/** whether this step is the canary the rest waits on */
	canary: boolean;
}

/**
 * The order tenants move in.
 *
 * One tenant first, health-checked, then the rest. A staged rollout that moves everything at once
 * is not a rollout; it is a deploy with extra vocabulary.
 */
export function rolloutPlan(tenants: string[], percent = 100): RolloutStep[] {
	if (tenants.length === 0) return [];
	const share = Math.max(1, Math.ceil((tenants.length * percent) / 100));
	return tenants.slice(0, share).map((tenant, order) => ({ tenant, order, canary: order === 0 }));
}

export interface PinHistory {
	pins: { pin: Pin; appliedAt: number }[];
}

export function previousPin(history: PinHistory): Pin | null {
	return history.pins.length < 2 ? null : (history.pins[history.pins.length - 2]?.pin ?? null);
}

/**
 * Resolves a workerd tag to its V8 version.
 *
 * Read from workerd's own `build/deps/v8.MODULE.bazel`, NEVER from `process.versions.v8`, which
 * workerd hardcodes to the empty string with the source comment "We don't want to provide real
 * versions". A doctor that introspects the runtime for this is designing against something that
 * does not exist.
 */
export async function resolveV8(ctx: Context, tag: string): Promise<string | null> {
	const url = `https://raw.githubusercontent.com/cloudflare/workerd/${tag}/build/deps/v8.MODULE.bazel`;
	try {
		const response = await ctx.fetch(url);
		if (!response.ok) return null;
		return /VERSION\s*=\s*"([^"]+)"/.exec(await response.text())?.[1] ?? null;
	} catch {
		return null;
	}
}
