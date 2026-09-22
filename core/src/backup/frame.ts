import { createHash } from 'node:crypto';

/**
 * Fixed 16 KiB framing, never content-defined chunking.
 *
 * strata measured CDC at 4.29 MB/s against 683 MB/s for fixed framing plus BLAKE2b -- 120 to 160
 * times slower than every other stage, and the bottleneck for the whole pipeline. Fixed frames
 * align with SQLite's 4 KiB pages, so an unchanged region produces identical frames anyway, which
 * is the property CDC was wanted for.
 */
export const FRAME_BYTES = 16 * 1024;

export interface Frame {
	index: number;
	digest: string;
	bytes: Uint8Array;
}

/** BLAKE2b-512 truncated to 256 bits: the fast hash, at a width nothing needs more than */
export function digestOf(bytes: Uint8Array): string {
	return createHash('blake2b512').update(bytes).digest('hex').slice(0, 64);
}

export function frames(bytes: Uint8Array, frameBytes = FRAME_BYTES): Frame[] {
	const out: Frame[] = [];
	for (let at = 0, index = 0; at < bytes.length; at += frameBytes, index++) {
		const slice = bytes.subarray(at, Math.min(at + frameBytes, bytes.length));
		out.push({ index, digest: digestOf(slice), bytes: slice });
	}
	return out;
}

export function join(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
