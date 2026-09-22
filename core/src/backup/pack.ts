import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { BastionError } from '../errors';
import { join, type Frame } from './frame';

/**
 * Compression levels, both measured by strata rather than picked.
 *
 * Level 1 on the hot path gives 4.28x at 422.9 MB/s; level 19 in compaction gives 5.86x at
 * 2.4 MB/s. The second number is why level 19 never runs where a backup is being taken.
 */
export const HOT_LEVEL = 1;
export const COMPACTION_LEVEL = 19;

/**
 * There is no `zstd -D` delta here, and that is a closed mechanism rather than a dropped goal.
 *
 * node's zlib exposes zstd's compression parameters but not its dictionary API, so a delta against
 * the previous version cannot be expressed through the runtime bastion ships on. The objective --
 * a new version costing only its changed bytes -- is met by the content-addressed frame store
 * instead: an unchanged 16 KiB region hashes to a digest the store already holds and is not
 * written again. That dedups across versions the way a delta would, and additionally across sites,
 * which a per-version dictionary could not.
 *
 * Revisit if node exposes `ZSTD_CCtx_loadDictionary`; the framing above is already the input a
 * dictionary delta would want.
 */
export const DELTA_MECHANISM = 'content-addressed frame dedup';

export interface PackEntry {
	digest: string;
	offset: number;
	length: number;
}

export interface Pack {
	id: string;
	entries: PackEntry[];
	/** the compressed, optionally encrypted body */
	body: Uint8Array;
	uncompressedBytes: number;
}

const SALT = 'bastion-backup-pack-v1';

// scrypt is deliberately expensive, and a pack run derives the same key for every pack. Held for
// the life of the process, which is no worse than the passphrase it came from already being there
const derived = new Map<string, Buffer>();

function keyFrom(passphrase: string): Buffer {
	const held = derived.get(passphrase);
	if (held !== undefined) return held;
	const key = scryptSync(passphrase, SALT, 32);
	derived.set(passphrase, key);
	return key;
}

/**
 * Seals a pack body.
 *
 * Encryption is on by default and a pack refuses to build without a key, because a backup target
 * is off-host by design: the whole point of the r2 driver set here is that the bytes leave the
 * box, and they carry every site's database.
 *
 * AES-256-GCM rather than XChaCha20-Poly1305 only because node ships one and not the other; both
 * are AEADs and the difference does not reach this use.
 */
export function seal(body: Uint8Array, passphrase: string): Uint8Array {
	const nonce = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', keyFrom(passphrase), nonce);
	const sealed = Buffer.concat([cipher.update(body), cipher.final()]);
	return new Uint8Array(Buffer.concat([nonce, cipher.getAuthTag(), sealed]));
}

export function unseal(sealed: Uint8Array, passphrase: string): Uint8Array {
	const nonce = sealed.subarray(0, 12);
	const tag = sealed.subarray(12, 28);
	const decipher = createDecipheriv('aes-256-gcm', keyFrom(passphrase), nonce);
	decipher.setAuthTag(tag);
	try {
		return new Uint8Array(
			Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()])
		);
	} catch {
		throw new BastionError('driver-refused', 'that pack did not open with the key given');
	}
}

export function buildPack(
	id: string,
	newFrames: Frame[],
	options: { level?: number; passphrase?: string | null } = {}
): Pack {
	if (options.passphrase === null) {
		throw new BastionError(
			'capability-refused',
			'backups are encrypted; set a key rather than writing every site database in the clear',
			{ next: 'bastion secrets set backup-key' }
		);
	}
	const entries: PackEntry[] = [];
	let offset = 0;
	for (const frame of newFrames) {
		entries.push({ digest: frame.digest, offset, length: frame.bytes.length });
		offset += frame.bytes.length;
	}
	const raw = join(newFrames.map((f) => f.bytes));
	const compressed = new Uint8Array(
		zstdCompressSync(raw, {
			params: { [constants.ZSTD_c_compressionLevel]: options.level ?? HOT_LEVEL }
		})
	);
	return {
		id,
		entries,
		uncompressedBytes: raw.length,
		body: options.passphrase === undefined ? compressed : seal(compressed, options.passphrase)
	};
}

export function readPack(pack: Pack, passphrase?: string): Map<string, Uint8Array> {
	const compressed = passphrase === undefined ? pack.body : unseal(pack.body, passphrase);
	const raw = new Uint8Array(zstdDecompressSync(compressed));
	const out = new Map<string, Uint8Array>();
	for (const entry of pack.entries) {
		out.set(entry.digest, raw.subarray(entry.offset, entry.offset + entry.length));
	}
	return out;
}

/**
 * Recompresses whole packs, never single frames.
 *
 * A per-frame rewrite against an object store is one Class A request each, which on a pack holding
 * a few thousand frames costs more than the compression saves.
 */
export function recompress(pack: Pack, passphrase?: string): Pack {
	const framesByDigest = readPack(pack, passphrase);
	const rebuilt: Frame[] = pack.entries.map((entry, index) => ({
		index,
		digest: entry.digest,
		bytes: framesByDigest.get(entry.digest) ?? new Uint8Array()
	}));
	return buildPack(pack.id, rebuilt, {
		level: COMPACTION_LEVEL,
		...(passphrase === undefined ? {} : { passphrase })
	});
}
