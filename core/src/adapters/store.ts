import { BastionError } from '../errors';
import type { Capabilities, Driver } from './capabilities';

export interface StoredValue {
	bytes: Uint8Array;
	/** epoch millis after which the value is gone, or null for no expiry */
	expiresAt: number | null;
	/** opaque per-key metadata a caller round-trips; absent where the endpoint cannot hold it */
	metadata?: Record<string, string>;
}

export interface ListPage {
	keys: { name: string; expiresAt: number | null }[];
	cursor: string | null;
}

export interface PutOptions {
	expiresAt?: number | null;
	metadata?: Record<string, string>;
	/** write only when the key is absent; honoured where `conditionalWrite` is true */
	ifAbsent?: boolean;
}

/**
 * A key/value store, which backs the KV adapter and the queue index.
 *
 * Two rules bind every implementation.
 *
 * **Never return partial content.** A short read or a truncated value raises; downstream code
 * cannot tell a truncated value from a real one.
 *
 * **A driver that cannot honour an option refuses the write rather than dropping it.** An object
 * stored without the metadata its reader expects is indistinguishable from a corrupt one.
 */
export interface KeyValueStore extends Driver {
	get(key: string): Promise<StoredValue | null>;
	put(key: string, bytes: Uint8Array, options?: PutOptions): Promise<void>;
	delete(keys: string[]): Promise<number>;
	list(prefix?: string, cursor?: string | null, limit?: number): Promise<ListPage>;
}

/** raised when a caller asks for something the endpoint cannot do */
export function refuse(driver: string, what: string): never {
	throw new BastionError(
		'driver-refused',
		`the ${driver} driver cannot ${what}, and will not drop it silently`
	);
}

/** guards the two rules above for any store implementation */
export function assertCanHonour(
	driver: string,
	caps: Capabilities,
	options: PutOptions | undefined,
	bytes: Uint8Array
): void {
	if (options?.ifAbsent === true && !caps.conditionalWrite) {
		refuse(driver, 'write conditionally on a key being absent');
	}
	if (options?.expiresAt !== undefined && options.expiresAt !== null && !caps.ttl) {
		refuse(driver, 'store a per-key expiry');
	}
	if (caps.maxValueBytes !== null && bytes.length > caps.maxValueBytes) {
		refuse(driver, `store ${bytes.length} bytes against its ${caps.maxValueBytes} byte limit`);
	}
}

/** whether a stored value has expired as of `now`; expiry is enforced on read wherever stored */
export function isExpired(value: StoredValue, now: number): boolean {
	return value.expiresAt !== null && value.expiresAt <= now;
}
