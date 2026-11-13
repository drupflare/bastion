import { createHash } from 'node:crypto';
import type { Context } from '../context';

const TYPES: Record<string, string> = {
	css: 'text/css; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	mjs: 'text/javascript; charset=utf-8',
	json: 'application/json',
	map: 'application/json',
	html: 'text/html; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	xml: 'application/xml',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	ico: 'image/x-icon',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	otf: 'font/otf',
	wasm: 'application/wasm',
	pdf: 'application/pdf',
	mp4: 'video/mp4',
	webm: 'video/webm'
};

/** the file a request path names inside the folder, or null for a path that is not exactly one file */
function fileFor(dir: string, pathname: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	if (decoded.includes('\\') || decoded.includes('\0')) return null;
	const segments = decoded.split('/').slice(1);
	if (segments.length === 0) return null;
	for (const segment of segments) {
		if (segment === '' || segment === '.' || segment === '..') return null;
	}
	return `${dir}/${segments.join('/')}`;
}

/**
 * Answers a request from a tenant's placed asset folder, the way Workers Assets answers before
 * the worker runs, and returns null when the path is not a file there.
 *
 * Without it the front door hands every request to workerd, which has the folder only as the
 * ASSETS binding, so a page's styles and scripts reach the worker as routes it does not have.
 * Only GET and HEAD are answered, and a validator lets a browser revalidate for a 304.
 */
export function assetResponse(ctx: Context, dir: string, request: Request): Response | null {
	if (request.method !== 'GET' && request.method !== 'HEAD') return null;
	const file = fileFor(dir, new URL(request.url).pathname);
	if (file === null || !ctx.files.exists(file) || ctx.files.isDirectory(file)) return null;
	const bytes = ctx.files.readBytes(file);
	const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`;
	const headers = new Headers({
		'cache-control': 'public, max-age=0, must-revalidate',
		'content-type':
			TYPES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()] ??
			'application/octet-stream',
		etag,
		'x-content-type-options': 'nosniff'
	});
	if (request.headers.get('if-none-match') === etag)
		return new Response(null, { status: 304, headers });
	headers.set('content-length', String(bytes.byteLength));
	return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}
