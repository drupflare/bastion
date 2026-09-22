/**
 * The dashboard, served from memory by the management listener.
 *
 * It is a prerendered single-page app with no server of its own, so the listener that answers its
 * API answers the app too. Held in memory rather than read from disk because the whole point of
 * embedding it in the binary is that a box with one file on it has its console: an install that
 * has to also ship a directory of assets is an install with a second way to go wrong.
 *
 * **Every `<script>` in the shipped page gets the request's nonce.** The CSP is
 * `script-src 'nonce-X' 'strict-dynamic'`, and the build emits an inline importmap, an inline
 * colour-mode script and an inline config block. Serving that page unmodified renders a blank
 * screen with three console errors and no other sign of what is wrong.
 */

import { CONTENT_TYPES } from '../adapters/assets';

export interface StaticAsset {
	bytes: Uint8Array;
	contentType: string;
}

/** the built app, keyed by the path it is served at, without a leading slash */
export type AssetBundle = Record<string, StaticAsset>;

export const INDEX = 'index.html';

/** what the management listener answers when nothing was embedded */
/** the extension map the asset adapter already carries; `contentTypeFor` is images, not files */
export function staticTypeFor(path: string): string {
	const dot = path.lastIndexOf('.');
	if (dot === -1) return 'application/octet-stream';
	return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

export const ABSENT_PAGE =
	'<!doctype html><meta charset="utf-8"><title>bastion</title>' +
	'<p>This build carries no dashboard. Build it with <code>bun run build:dashboard</code>, ' +
	'or use the CLI: <code>bastion status</code>.</p>';

/** builds the bundle from a directory listing, so a generator and a test agree on the shape */
export function bundleFrom(files: Record<string, Uint8Array>): AssetBundle {
	const bundle: AssetBundle = {};
	for (const [path, bytes] of Object.entries(files)) {
		const key = path.replace(/^\/+/, '');
		bundle[key] = { bytes, contentType: staticTypeFor(key) };
	}
	return bundle;
}

const NONCED = /<script(?![^>]*\snonce=)/g;

export function withNonce(html: string, nonce: string): string {
	return html.replace(NONCED, `<script nonce="${nonce}"`);
}

/**
 * The asset a path resolves to, or null when the caller should answer 404 itself.
 *
 * A path with no extension falls back to the app shell, because the router is in the browser and
 * `/tenants` is a page rather than a file. A path WITH an extension does not: answering a missing
 * `.js` with html turns a bad build into a syntax error in the console rather than a 404.
 */
export function resolveAsset(bundle: AssetBundle, pathname: string): StaticAsset | null {
	const key = pathname.replace(/^\/+/, '');
	const direct = bundle[key === '' ? INDEX : key];
	if (direct !== undefined) return direct;

	// an extension the asset map knows is a request for a file, and a missing one is a 404.
	// Anything else is a route: `/sites/www.example.edu` ends in `.edu`, and reading that as an
	// extension served a 404 for the page an operator reaches by clicking a site
	const dot = key.lastIndexOf('.');
	const extension = dot === -1 ? '' : key.slice(dot).toLowerCase();
	if (extension !== '' && CONTENT_TYPES[extension] !== undefined) return null;
	return bundle[INDEX] ?? null;
}

export interface StaticOptions {
	nonce: string;
	headers?: Record<string, string>;
}

export function serveStatic(
	bundle: AssetBundle,
	pathname: string,
	options: StaticOptions
): Response | null {
	if (Object.keys(bundle).length === 0) {
		return new Response(withNonce(ABSENT_PAGE, options.nonce), {
			status: 200,
			headers: { ...options.headers, 'content-type': 'text/html; charset=utf-8' }
		});
	}

	const asset = resolveAsset(bundle, pathname);
	if (asset === null) return null;

	// the build names every hashed file after its contents, so those are immutable; the shell is
	// not, and a cached shell pointing at a replaced bundle is an upgrade that renders nothing
	const hashed = pathname.startsWith('/_nuxt/');
	const headers: Record<string, string> = {
		...options.headers,
		'content-type': asset.contentType,
		'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache'
	};

	if (asset.contentType.startsWith('text/html')) {
		const html = withNonce(new TextDecoder().decode(asset.bytes), options.nonce);
		return new Response(html, { status: 200, headers });
	}
	return new Response(asset.bytes, { status: 200, headers });
}
