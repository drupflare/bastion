import { capabilities } from '../adapters/capabilities';
import { assertComplete, etagOf, type ObjectMeta, type ObjectStore } from '../adapters/objects';
import type { Context } from '../context';
import { BastionError } from '../errors';

export interface RemoteEntry {
	name: string;
	size: number;
	/** epoch millis, or 0 where the protocol did not carry one */
	modifiedAt: number;
	directory: boolean;
}

/**
 * The shape an SFTP or FTP client has to satisfy.
 *
 * Structural and minimal, the way `CollegeDB` states its client contracts: bastion takes any
 * object with these methods and depends on no specific library, so an operator brings `ssh2-sftp-client`,
 * `basic-ftp`, or something they wrote. Optional methods are probed rather than required, because
 * the two protocols do not carry the same metadata and a client that cannot stat is still useful.
 */
export interface RemoteFileClient {
	list(path: string): Promise<RemoteEntry[]>;
	get(path: string): Promise<Uint8Array>;
	put(path: string, bytes: Uint8Array): Promise<void>;
	delete(path: string): Promise<void>;
	mkdir?(path: string): Promise<void>;
	stat?(path: string): Promise<{ size: number; modifiedAt: number } | null>;
	exists?(path: string): Promise<boolean>;
	end?(): Promise<void>;
}

function joinPath(root: string, key: string): string {
	if (key.split('/').some((s) => s === '..')) {
		throw new BastionError(
			'driver-refused',
			`the key ${JSON.stringify(key)} climbs out of the root`
		);
	}
	return `${root.replace(/\/$/, '')}/${key}`;
}

/**
 * Objects over a file-transfer protocol.
 *
 * Neither SFTP nor FTP has conditional writes, ranged reads or server-side listing cursors, so the
 * capability object says so and the engine takes the slower path rather than the driver pretending.
 * A `put` that was asked for metadata it cannot carry refuses instead of dropping it.
 */
export function remoteObjectStore(
	ctx: Context,
	id: 'sftp' | 'ftp',
	client: RemoteFileClient,
	root: string
): ObjectStore {
	let unreachable: string | null = null;

	const walk = async (dir: string, prefix: string, out: ObjectMeta[]): Promise<void> => {
		let entries: RemoteEntry[];
		try {
			entries = await client.list(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.directory) await walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`, out);
			else {
				out.push({
					key: `${prefix}${entry.name}`,
					size: entry.size,
					etag: '',
					uploadedAt: entry.modifiedAt
				});
			}
		}
	};

	return {
		id: () => id,
		label: () => `${id} (${root})`,
		capabilities: () => capabilities({ batchDelete: false }),
		isReachable: async () => {
			try {
				await client.list(root);
				unreachable = null;
				return true;
			} catch (e) {
				unreachable = e instanceof Error ? e.message : String(e);
				return false;
			}
		},
		unreachableReason: () => unreachable,

		head: async (key) => {
			const path = joinPath(root, key);
			if (client.stat !== undefined) {
				const stat = await client.stat(path);
				return stat === null
					? null
					: { key, size: stat.size, etag: '', uploadedAt: stat.modifiedAt };
			}
			try {
				const bytes = await client.get(path);
				return { key, size: bytes.length, etag: etagOf(bytes), uploadedAt: 0 };
			} catch {
				// the client could not read it; a refused key already raised above
				return null;
			}
		},

		get: async (key, range) => {
			// resolved OUTSIDE the catch on purpose: a key that climbs out of the root is a
			// refusal, and swallowing it into a null would report an attempted escape as a miss
			const path = joinPath(root, key);
			let bytes: Uint8Array;
			try {
				bytes = await client.get(path);
			} catch {
				return null;
			}
			if (range === undefined) {
				return {
					bytes,
					meta: { key, size: bytes.length, etag: etagOf(bytes), uploadedAt: 0 }
				};
			}
			const slice = bytes.subarray(range.offset, range.offset + range.length);
			assertComplete(
				id,
				key,
				Math.min(range.length, bytes.length - range.offset),
				slice.length
			);
			return {
				bytes: slice,
				meta: { key, size: bytes.length, etag: etagOf(bytes), uploadedAt: 0 }
			};
		},

		put: async (key, bytes, options) => {
			if (options?.customMetadata !== undefined || options?.httpMetadata !== undefined) {
				throw new BastionError(
					'driver-refused',
					`the ${id} driver cannot store metadata beside an object, and will not drop it silently`
				);
			}
			const path = joinPath(root, key);
			if (options?.ifAbsent === true) {
				throw new BastionError(
					'driver-refused',
					`the ${id} driver cannot write conditionally on a key being absent`
				);
			}
			const parent = path.slice(0, path.lastIndexOf('/'));
			if (client.mkdir !== undefined) await client.mkdir(parent);
			await client.put(path, bytes);
			return { key, size: bytes.length, etag: etagOf(bytes), uploadedAt: ctx.now() };
		},

		delete: async (keys) => {
			let removed = 0;
			for (const key of keys) {
				const path = joinPath(root, key);
				try {
					await client.delete(path);
					removed++;
				} catch {
					// a key that is already gone is not a failure; delete is idempotent
				}
			}
			return removed;
		},

		list: async (prefix = '', cursor = null, limit = 1000) => {
			const all: ObjectMeta[] = [];
			await walk(root, '', all);
			const matching = all
				.filter((o) => o.key.startsWith(prefix))
				.sort((a, b) => a.key.localeCompare(b.key));
			const from = cursor === null ? 0 : matching.findIndex((o) => o.key > cursor);
			const start = from === -1 ? matching.length : from;
			const page = matching.slice(start, start + limit);
			return {
				objects: page,
				cursor:
					start + limit < matching.length ? (page[page.length - 1]?.key ?? null) : null
			};
		}
	};
}
