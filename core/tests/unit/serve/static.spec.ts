import { describe, expect, it } from 'vitest';
import {
	ABSENT_PAGE,
	bundleFrom,
	resolveAsset,
	serveStatic,
	staticTypeFor,
	withNonce
} from '../../../src/serve/static';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const SHELL =
	'<!doctype html><html><head>' +
	'<script type="importmap">{"imports":{}}</script>' +
	'<script type="module" src="/_nuxt/entry.js" crossorigin></script>' +
	'</head><body><div id="__nuxt"></div>' +
	'<script>window.__NUXT__={}</script></body></html>';

const app = () =>
	bundleFrom({
		'index.html': bytes(SHELL),
		'_nuxt/entry.js': bytes('export default 1'),
		'_nuxt/entry.css': bytes('body{}'),
		'favicon.png': bytes('\x89PNG')
	});

describe('staticTypeFor', () => {
	it('reads the extension map the asset adapter already carries', () => {
		expect(staticTypeFor('index.html')).toContain('text/html');
		expect(staticTypeFor('_nuxt/a.js')).toContain('javascript');
		expect(staticTypeFor('_nuxt/a.css')).toContain('text/css');
	});

	it('does not guess at an extension it has never seen', () => {
		expect(staticTypeFor('thing.qqq')).toBe('application/octet-stream');
		expect(staticTypeFor('LICENSE')).toBe('application/octet-stream');
	});
});

describe('resolveAsset', () => {
	it('answers the root with the shell', () => {
		const bundle = app();
		expect(resolveAsset(bundle, '/')).toBe(bundle['index.html']);
		expect(new TextDecoder().decode(resolveAsset(bundle, '/')?.bytes)).toContain('__nuxt');
	});

	it('answers a built file with itself', () => {
		expect(new TextDecoder().decode(resolveAsset(app(), '/_nuxt/entry.js')?.bytes)).toBe(
			'export default 1'
		);
	});

	it('falls back to the shell for a route, because the router is in the browser', () => {
		for (const path of ['/tenants', '/sites/www.example.edu', '/health']) {
			expect(resolveAsset(app(), path)?.contentType, path).toContain('text/html');
		}
	});

	/** answering a missing .js with html turns a bad build into a console syntax error */
	it('does not fall back for a path that names a file', () => {
		expect(resolveAsset(app(), '/_nuxt/gone.js')).toBe(null);
		expect(resolveAsset(app(), '/missing.css')).toBe(null);
		expect(resolveAsset(app(), '/missing.png')).toBe(null);
	});

	/** a hostname in a route ends in something that looks exactly like an extension */
	it('reads a dotted route as a route rather than as a file', () => {
		for (const path of ['/sites/www.example.edu', '/sites/docs.example.edu/versions']) {
			expect(resolveAsset(app(), path)?.contentType, path).toContain('text/html');
		}
	});

	it('answers nothing at all when nothing was embedded', () => {
		expect(resolveAsset({}, '/')).toBe(null);
	});
});

describe('withNonce', () => {
	it('nonces every script, because the csp allows no unnonced one', () => {
		const html = withNonce(SHELL, 'abc123');
		expect(html.match(/<script nonce="abc123"/g)).toHaveLength(3);
		expect(html).not.toMatch(/<script(?! nonce)/);
	});

	it('leaves a script that already carries one alone', () => {
		expect(withNonce('<script nonce="x">1</script>', 'y')).toBe('<script nonce="x">1</script>');
	});

	it('leaves the closing tag alone', () => {
		expect(withNonce('<script>1</script>', 'n')).toBe('<script nonce="n">1</script>');
	});
});

describe('serveStatic', () => {
	const nonce = 'n0nce';

	it('serves the shell with the nonce the header announced', async () => {
		const response = serveStatic(app(), '/', { nonce }) as Response;
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(await response.text()).toContain(`<script nonce="${nonce}"`);
	});

	it('marks a hashed asset immutable and the shell not', () => {
		expect(
			(serveStatic(app(), '/_nuxt/entry.js', { nonce }) as Response).headers.get(
				'cache-control'
			)
		).toContain('immutable');
		expect((serveStatic(app(), '/', { nonce }) as Response).headers.get('cache-control')).toBe(
			'no-cache'
		);
	});

	it('carries the headers the caller computed, so the csp travels with the page', () => {
		const response = serveStatic(app(), '/', {
			nonce,
			headers: { 'content-security-policy': `script-src 'nonce-${nonce}'` }
		}) as Response;
		expect(response.headers.get('content-security-policy')).toContain(nonce);
	});

	it('returns null for a file that is not there, so the caller answers 404', () => {
		expect(serveStatic(app(), '/_nuxt/gone.js', { nonce })).toBe(null);
	});

	it('says the dashboard was not built rather than answering a blank 404', async () => {
		const response = serveStatic({}, '/', { nonce }) as Response;
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain('carries no dashboard');
		expect(body).toContain('bun run build:dashboard');
	});

	it('nonces that page too, since the same csp applies to it', () => {
		expect(ABSENT_PAGE).not.toContain('<script');
		expect(serveStatic({}, '/anything', { nonce })).not.toBe(null);
	});

	it('serves bytes unchanged for anything that is not html', async () => {
		const response = serveStatic(app(), '/favicon.png', { nonce }) as Response;
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes('\x89PNG'));
	});
});
