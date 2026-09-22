import { BastionError } from '../errors';
import type { Driver } from './capabilities';

export interface ObjectMeta {
	key: string;
	size: number;
	etag: string;
	uploadedAt: number;
	httpMetadata?: Record<string, string>;
	customMetadata?: Record<string, string>;
}

export interface ObjectBody {
	meta: ObjectMeta;
	bytes: Uint8Array;
}

export interface ByteRange {
	offset: number;
	length: number;
}

export interface PutObjectOptions {
	httpMetadata?: Record<string, string>;
	customMetadata?: Record<string, string>;
	/** write only when the key is absent; honoured where `conditionalWrite` is true */
	ifAbsent?: boolean;
}

export interface ObjectPage {
	objects: ObjectMeta[];
	cursor: string | null;
}

/**
 * A blob store, which backs the R2 adapter and every backup target.
 *
 * One contract for both is deliberate: an off-host backup and an R2 bucket are the same operation
 * against the same endpoints, so a second implementation would be a second set of credential
 * handling and a second set of retry bugs.
 *
 * The two store rules bind here as they do for a key/value store. **Never return partial content**
 * -- a short read raises rather than answering with fewer bytes, because a truncated object is
 * indistinguishable from a real one. And **a driver that cannot honour an option refuses the write
 * rather than dropping it**, so an object stored without the metadata its reader expects never
 * exists.
 */
export interface ObjectStore extends Driver {
	head(key: string): Promise<ObjectMeta | null>;
	get(key: string, range?: ByteRange): Promise<ObjectBody | null>;
	put(key: string, bytes: Uint8Array, options?: PutObjectOptions): Promise<ObjectMeta>;
	delete(keys: string[]): Promise<number>;
	list(prefix?: string, cursor?: string | null, limit?: number): Promise<ObjectPage>;
}

/** raised when a read came back short, which every driver checks rather than trusting the wire */
export function assertComplete(driver: string, key: string, expected: number, got: number): void {
	if (expected !== got) {
		throw new BastionError(
			'driver-refused',
			`${driver} returned ${got} bytes of ${key} against the ${expected} it declared; ` +
				'a short read is refused rather than returned'
		);
	}
}

export function etagOf(bytes: Uint8Array): string {
	let hash = 0x811c9dc5;
	for (const byte of bytes) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `"${hash.toString(16).padStart(8, '0')}-${bytes.length.toString(16)}"`;
}
