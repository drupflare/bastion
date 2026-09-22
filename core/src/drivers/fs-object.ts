import { capabilities } from '../adapters/capabilities';
import { assertComplete, etagOf, type ObjectStore } from '../adapters/objects';
import type { Context } from '../context';
import { BastionError } from '../errors';

const META_SUFFIX = '.meta.json';

/** a key that cannot climb out of the root, checked before anything touches the disk */
export function objectPath(root: string, key: string): string {
	if (key === '' || key.startsWith('/') || key.split('/').some((s) => s === '..' || s === '.')) {
		throw new BastionError(
			'driver-refused',
			`the fs driver refuses the key ${JSON.stringify(key)}`
		);
	}
	return `${root}/${key}`;
}

/**
 * Objects on local disk.
 *
 * The default r2 driver and the default backup target, because an operator who has not chosen a
 * cloud has a disk. Metadata rides in a sidecar rather than in an extended attribute: xattrs are
 * not portable across the filesystems a university box actually runs, and an object whose metadata
 * silently did not survive a copy is the failure the refuse-rather-than-drop rule exists to stop.
 */
export function fsObjectStore(ctx: Context, root: string): ObjectStore {
	const caps = capabilities({
		conditionalWrite: true,
		byteRange: true,
		batchDelete: true,
		pagedList: true
	});

	const readMeta = (key: string) => {
		const path = `${objectPath(root, key)}${META_SUFFIX}`;
		if (!ctx.files.exists(path)) return null;
		return JSON.parse(ctx.files.readText(path)) as {
			httpMetadata?: Record<string, string>;
			customMetadata?: Record<string, string>;
			uploadedAt: number;
			etag: string;
		};
	};

	const walk = (dir: string, prefix: string, out: string[]): void => {
		if (!ctx.files.exists(dir)) return;
		for (const entry of ctx.files.readDir(dir)) {
			const child = `${dir}/${entry.name}`;
			if (entry.directory) walk(child, `${prefix}${entry.name}/`, out);
			else if (!entry.name.endsWith(META_SUFFIX)) out.push(`${prefix}${entry.name}`);
		}
	};

	return {
		id: () => 'fs',
		label: () => `Local disk (${root})`,
		capabilities: () => caps,
		isReachable: async () => {
			try {
				ctx.files.mkdirp(root);
				return true;
			} catch {
				return false;
			}
		},
		unreachableReason: () => null,

		head: async (key) => {
			const path = objectPath(root, key);
			if (!ctx.files.exists(path)) return null;
			const meta = readMeta(key);
			const size = ctx.files.size(path);
			return {
				key,
				size,
				etag: meta?.etag ?? '',
				uploadedAt: meta?.uploadedAt ?? 0,
				...(meta?.httpMetadata === undefined ? {} : { httpMetadata: meta.httpMetadata }),
				...(meta?.customMetadata === undefined
					? {}
					: { customMetadata: meta.customMetadata })
			};
		},

		get: async (key, range) => {
			const path = objectPath(root, key);
			if (!ctx.files.exists(path)) return null;
			const all = ctx.files.readBytes(path);
			assertComplete('fs', key, ctx.files.size(path), all.length);
			const meta = readMeta(key);
			const bytes =
				range === undefined ? all : all.subarray(range.offset, range.offset + range.length);
			if (
				range !== undefined &&
				bytes.length !== Math.min(range.length, all.length - range.offset)
			) {
				assertComplete('fs', key, range.length, bytes.length);
			}
			return {
				bytes,
				meta: {
					key,
					size: all.length,
					etag: meta?.etag ?? etagOf(all),
					uploadedAt: meta?.uploadedAt ?? 0,
					...(meta?.httpMetadata === undefined
						? {}
						: { httpMetadata: meta.httpMetadata }),
					...(meta?.customMetadata === undefined
						? {}
						: { customMetadata: meta.customMetadata })
				}
			};
		},

		put: async (key, bytes, options) => {
			const path = objectPath(root, key);
			if (options?.ifAbsent === true && ctx.files.exists(path)) {
				throw new BastionError('driver-refused', `${key} already exists`);
			}
			ctx.files.writeBytes(path, bytes);
			const meta = {
				etag: etagOf(bytes),
				uploadedAt: ctx.now(),
				...(options?.httpMetadata === undefined
					? {}
					: { httpMetadata: options.httpMetadata }),
				...(options?.customMetadata === undefined
					? {}
					: { customMetadata: options.customMetadata })
			};
			ctx.files.writeText(`${path}${META_SUFFIX}`, JSON.stringify(meta));
			return { key, size: bytes.length, ...meta };
		},

		delete: async (keys) => {
			let removed = 0;
			for (const key of keys) {
				const path = objectPath(root, key);
				if (!ctx.files.exists(path)) continue;
				ctx.files.remove(path);
				if (ctx.files.exists(`${path}${META_SUFFIX}`))
					ctx.files.remove(`${path}${META_SUFFIX}`);
				removed++;
			}
			return removed;
		},

		list: async (prefix = '', cursor = null, limit = 1000) => {
			const all: string[] = [];
			walk(root, '', all);
			const matching = all.filter((k) => k.startsWith(prefix)).sort();
			const start = cursor === null ? 0 : matching.findIndex((k) => k > cursor);
			const from = start === -1 ? matching.length : start;
			const page = matching.slice(from, from + limit);
			const objects = page.map((key) => {
				const meta = readMeta(key);
				return {
					key,
					size: ctx.files.size(objectPath(root, key)),
					etag: meta?.etag ?? '',
					uploadedAt: meta?.uploadedAt ?? 0
				};
			});
			return {
				objects,
				cursor: from + limit < matching.length ? (page[page.length - 1] ?? null) : null
			};
		}
	};
}
