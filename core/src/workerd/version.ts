import { FLOOR_REASONS } from '../config/defaults';
import { BastionError } from '../errors';

/** a workerd release tag, `v1.20260828.1`, or the bare `1.20260828.1` a package.json carries */
const WORKERD_TAG = /^v?(\d+)\.(\d{8})\.(\d+)$/;
/** a firecracker semver */
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

export type Comparison = -1 | 0 | 1;

function compareParts(a: number[], b: number[]): Comparison {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const left = a[i] ?? 0;
		const right = b[i] ?? 0;
		if (left < right) return -1;
		if (left > right) return 1;
	}
	return 0;
}

export function parseWorkerdVersion(value: string): number[] | null {
	const match = WORKERD_TAG.exec(value.trim());
	if (match === null) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function parseSemver(value: string): number[] | null {
	const match = SEMVER.exec(value.trim());
	if (match === null) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareWorkerd(a: string, b: string): Comparison | null {
	const left = parseWorkerdVersion(a);
	const right = parseWorkerdVersion(b);
	if (left === null || right === null) return null;
	return compareParts(left, right);
}

export function compareSemver(a: string, b: string): Comparison | null {
	const left = parseSemver(a);
	const right = parseSemver(b);
	if (left === null || right === null) return null;
	return compareParts(left, right);
}

export interface FloorVerdict {
	ok: boolean;
	/** the reason the floor exists, so a refusal names the CVE rather than just the number */
	reason: string;
	message: string;
}

/**
 * Whether a version clears its floor.
 *
 * A floor exists because a version below it carries a known, reachable CVE, so the refusal names
 * it. `--force-below-floor` may still accept one; what it may not do is accept one silently.
 */
export function checkFloor(
	component: 'workerd' | 'firecracker',
	version: string,
	floor: string
): FloorVerdict {
	const cmp =
		component === 'workerd' ? compareWorkerd(version, floor) : compareSemver(version, floor);
	const reason = FLOOR_REASONS[component] ?? '';
	if (cmp === null) {
		return {
			ok: false,
			reason,
			message: `cannot compare ${component} \`${version}\` against the floor \`${floor}\``
		};
	}
	if (cmp < 0) {
		return {
			ok: false,
			reason,
			message: `${component} ${version} is below the floor ${floor}: ${reason}`
		};
	}
	return { ok: true, reason, message: '' };
}

/** raises unless the version clears its floor, or the caller has explicitly accepted the CVE */
export function requireFloor(
	component: 'workerd' | 'firecracker',
	version: string,
	floor: string,
	force = false
): FloorVerdict {
	const verdict = checkFloor(component, version, floor);
	if (verdict.ok || force) return verdict;
	throw new BastionError('below-floor', verdict.message, {
		next: `bastion update apply --to ${floor}`
	});
}
