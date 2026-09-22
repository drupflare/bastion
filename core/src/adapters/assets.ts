import { extname, normalize, resolve } from 'node:path';
import type { FileHost } from '../host/files';

/**
 * Content types bastion serves, by extension.
 *
 * A bare `DiskDirectory` answers everything `application/octet-stream`, which breaks every
 * stylesheet and script on a rendered page. Anything absent from this table is not servable at
 * all rather than guessed at.
 */
export const CONTENT_TYPES: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.eot': 'application/vnd.ms-fontobject',
	'.pdf': 'application/pdf',
	'.wasm': 'application/wasm'
};

/**
 * Paths never served, whatever the ignore file says.
 *
 * The smoke lane served `/drupal/site.sqlite` publicly -- the whole site database -- because a
 * bare disk service has no opinion about what it holds. These patterns are the floor under the
 * per-profile ignore list, so a missing or malformed ignore file cannot open them.
 */
export const NEVER_SERVED = [
	/(^|\/)\.[^/]+$/, // dotfiles
	/\.sqlite(-wal|-shm|-journal)?$/i,
	/\.(db|sql|pem|key|p12|pfx|env)$/i,
	/(^|\/)(node_modules|vendor)\//
];

export interface AssetProfile {
	/** the ignore file a CMS ships, named per probe profile rather than hardcoded */
	ignoreFile: string;
}

/** drupflare ships `.assetsignore`; a different CMS names its own */
export const ASSET_PROFILES: Record<string, AssetProfile> = {
	drupflare: { ignoreFile: '.assetsignore' },
	generic: { ignoreFile: '.assetsignore' }
};

/** one ignore rule; `*` matches within a segment and `**` across them */
export function compileIgnore(contents: string): RegExp[] {
	return contents
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'))
		.map((line) => {
			const anchored = line.startsWith('/') ? line.slice(1) : line;
			const escaped = anchored
				.replace(/[.+^${}()|[\]\\]/g, '\\$&')
				.replace(/\*\*/g, '\u0000')
				.replace(/\*/g, '[^/]*')
				.replace(/\u0000/g, '.*');
			const suffix = line.endsWith('/') ? '.*' : '(/.*)?';
			return new RegExp(`^/?${escaped}${suffix}$`);
		});
}

export interface AssetResolver {
	(path: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
}

/**
 * Resolves an asset path against a directory, applying the floor, the ignore list and a real
 * content type.
 *
 * Path traversal is refused by resolving and then checking containment, rather than by filtering
 * `..` out of the input: a filter is a list of the tricks someone thought of.
 */
export function assetResolver(
	files: FileHost,
	root: string,
	profile: AssetProfile = ASSET_PROFILES.generic as AssetProfile
): AssetResolver {
	const base = resolve(root);
	const ignorePath = `${base}/${profile.ignoreFile}`;
	const ignore = files.exists(ignorePath) ? compileIgnore(files.readText(ignorePath)) : [];

	return async (path: string) => {
		const clean = normalize(path);
		if (NEVER_SERVED.some((p) => p.test(clean))) return null;
		if (ignore.some((p) => p.test(clean))) return null;

		const full = resolve(base, `.${clean.startsWith('/') ? clean : `/${clean}`}`);
		if (full !== base && !full.startsWith(`${base}/`)) return null;
		if (!files.exists(full)) return null;

		const contentType = CONTENT_TYPES[extname(full).toLowerCase()];
		// an unknown extension is not servable; guessing is how a database becomes a download
		if (contentType === undefined) return null;
		return { bytes: files.readBytes(full), contentType };
	};
}
