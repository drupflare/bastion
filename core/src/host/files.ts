import * as fs from 'node:fs';
import { Dirent } from 'node:fs';
import { dirname } from 'node:path';

/** one entry in a directory listing */
export interface FileEntry {
	name: string;
	directory: boolean;
}

/**
 * The filesystem seam.
 *
 * **Holds BYTES.** `readBytes` / `writeBytes` exist because a site database and a workerd binary
 * are not text, and the memory implementation stores `Uint8Array` rather than encoding on read --
 * so `size()` and `readBytes().length` agree for the same reason they agree on a real disk. A
 * fixture that stored the string and encoded per call would read a binary member back as
 * something else.
 */
export interface FileHost {
	exists(path: string): boolean;
	readText(path: string): string;
	readBytes(path: string): Uint8Array;
	writeText(path: string, contents: string): void;
	/** adds to the end, creating the file when it is absent; an append-only log is the caller */
	appendText(path: string, contents: string): void;
	writeBytes(path: string, contents: Uint8Array): void;
	readDir(path: string): FileEntry[];
	/** whether the path is a directory; false for a file and for one that is not there */
	isDirectory(path: string): boolean;
	mkdirp(path: string): void;
	/** removes one file; a missing path is not an error, so a delete is idempotent */
	remove(path: string): void;
	size(path: string): number;
	/** POSIX mode bits, or null where the path is absent */
	mode(path: string): number | null;
	chmod(path: string, mode: number): void;
	/** bytes on the filesystem holding this path, or null where it cannot be read */
	space(path: string): { totalBytes: number; freeBytes: number } | null;
}

export function nodeFiles(): FileHost {
	return {
		exists: (p) => fs.existsSync(p),
		readText: (p) => fs.readFileSync(p, 'utf8'),
		readBytes: (p) => new Uint8Array(fs.readFileSync(p)),
		appendText: (p, c) => fs.appendFileSync(p, c),
		writeText: (p, c) => {
			fs.mkdirSync(dirname(p), { recursive: true });
			fs.writeFileSync(p, c, 'utf8');
		},
		writeBytes: (p, c) => {
			fs.mkdirSync(dirname(p), { recursive: true });
			fs.writeFileSync(p, c);
		},
		readDir: (p) =>
			fs
				.readdirSync(p, { withFileTypes: true })
				.map((e: Dirent) => ({ name: e.name, directory: e.isDirectory() })),
		isDirectory: (p) => {
			try {
				return fs.statSync(p).isDirectory();
			} catch {
				return false;
			}
		},
		mkdirp: (p) => {
			fs.mkdirSync(p, { recursive: true });
		},
		remove: (p) => {
			fs.rmSync(p, { force: true, recursive: false });
		},
		size: (p) => fs.statSync(p).size,
		mode: (p) => (fs.existsSync(p) ? fs.statSync(p).mode & 0o7777 : null),
		chmod: (p, m) => fs.chmodSync(p, m),
		space: (p) => {
			try {
				const stat = fs.statfsSync(p);
				return {
					totalBytes: Number(stat.blocks) * Number(stat.bsize),
					freeBytes: Number(stat.bavail) * Number(stat.bsize)
				};
			} catch {
				return null;
			}
		}
	};
}

/** in-memory files for the gate lane; no test touches a real disk */
export function memoryFiles(
	seed: Record<string, string | Uint8Array> = {},
	space: { totalBytes: number; freeBytes: number } | null = null
): FileHost {
	const store = new Map<string, Uint8Array>();
	const modes = new Map<string, number>();
	const dirs = new Set<string>(['/']);
	const enc = new TextEncoder();
	const norm = (p: string): string => p.replace(/\/+$/, '') || '/';

	// walks all the way up rather than stopping at the first directory already known: a real
	// mkdir -p creates every missing ancestor, and stopping early left grandparents unlisted
	const addParents = (p: string): void => {
		let d = dirname(norm(p));
		while (d && d !== '/') {
			dirs.add(d);
			d = dirname(d);
		}
	};

	for (const [path, value] of Object.entries(seed)) {
		store.set(norm(path), typeof value === 'string' ? enc.encode(value) : value);
		addParents(path);
	}

	const host: FileHost = {
		exists: (p) => store.has(norm(p)) || dirs.has(norm(p)),
		readText: (p) => {
			const bytes = store.get(norm(p));
			if (bytes === undefined) throw new Error(`ENOENT: ${p}`);
			return new TextDecoder().decode(bytes);
		},
		readBytes: (p) => {
			const bytes = store.get(norm(p));
			if (bytes === undefined) throw new Error(`ENOENT: ${p}`);
			return bytes;
		},
		writeText: (p, c) => {
			store.set(norm(p), enc.encode(c));
			addParents(p);
		},
		appendText: (p, c) => {
			const held = store.get(norm(p));
			const prefix = held === undefined ? '' : new TextDecoder().decode(held);
			store.set(norm(p), enc.encode(`${prefix}${c}`));
			addParents(p);
		},
		writeBytes: (p, c) => {
			store.set(norm(p), c);
			addParents(p);
		},
		// a path is a directory when something was written under it, which is the only way the
		// memory host learns one exists
		isDirectory: (p) => dirs.has(norm(p)),
		readDir: (p) => {
			const base = norm(p);
			const prefix = base === '/' ? '/' : `${base}/`;
			const seen = new Map<string, boolean>();
			for (const key of [...store.keys(), ...dirs]) {
				if (!key.startsWith(prefix) || key === base) continue;
				const rest = key.slice(prefix.length);
				const head = rest.split('/')[0];
				if (head === undefined || head === '') continue;
				const isDir = rest.includes('/') || dirs.has(`${prefix}${head}`);
				seen.set(head, (seen.get(head) ?? false) || isDir);
			}
			return [...seen].map(([name, directory]) => ({ name, directory }));
		},
		mkdirp: (p) => {
			dirs.add(norm(p));
			addParents(`${norm(p)}/x`);
		},
		remove: (p) => {
			store.delete(norm(p));
			modes.delete(norm(p));
		},
		size: (p) => {
			const bytes = store.get(norm(p));
			if (bytes === undefined) throw new Error(`ENOENT: ${p}`);
			return bytes.length;
		},
		mode: (p) => (host.exists(p) ? (modes.get(norm(p)) ?? 0o644) : null),
		chmod: (p, m) => {
			modes.set(norm(p), m);
		},
		space: () => space
	};
	return host;
}
