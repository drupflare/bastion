import { describe, expect, it } from 'vitest';
import { defaultContext, type Context } from '../../../src/context';
import { assetResponse } from '../../../src/front/assets';
import { socketPaths, unixUpstream } from '../../../src/front/upstream';
import { memoryFiles } from '../../../src/host/files';

const DIR = '/state/tenants/acme/assets';

function ctxWith(seed: Record<string, string>): Context {
	return { ...defaultContext(), files: memoryFiles(seed) };
}

function get(path: string, init: RequestInit = {}): Request {
	return new Request(`https://www.example.edu${path}`, init);
}

describe('assetResponse', () => {
	const ctx = ctxWith({
		[`${DIR}/agg/a.css`]: 'body{}',
		[`${DIR}/core/misc/drupal.js`]: 'x',
		[`${DIR}/robots.txt`]: 'User-agent: *',
		[`${DIR}/data.bin`]: 'b',
		'/state/tenants/acme/secret.txt': 'no'
	});

	it('answers a placed file with its type, size and a validator', async () => {
		const res = assetResponse(ctx, DIR, get('/agg/a.css'))!;
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
		expect(res.headers.get('content-length')).toBe('6');
		expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
		expect(await res.text()).toBe('body{}');
	});

	it('ignores the query string and types a script and a file it has no type for', () => {
		expect(
			assetResponse(ctx, DIR, get('/core/misc/drupal.js?v=11'))!.headers.get('content-type')
		).toBe('text/javascript; charset=utf-8');
		expect(assetResponse(ctx, DIR, get('/data.bin'))!.headers.get('content-type')).toBe(
			'application/octet-stream'
		);
	});

	it('answers HEAD with the headers and no body', async () => {
		const res = assetResponse(ctx, DIR, get('/robots.txt', { method: 'HEAD' }))!;
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe('13');
		expect(await res.text()).toBe('');
	});

	it('answers 304 when the validator matches', () => {
		const etag = assetResponse(ctx, DIR, get('/agg/a.css'))!.headers.get('etag')!;
		const res = assetResponse(
			ctx,
			DIR,
			get('/agg/a.css', { headers: { 'if-none-match': etag } })
		)!;
		expect(res.status).toBe(304);
	});

	it('passes a path that is not a file, a folder, or a write on to the worker', () => {
		expect(assetResponse(ctx, DIR, get('/node/1'))).toBeNull();
		expect(assetResponse(ctx, DIR, get('/agg'))).toBeNull();
		expect(assetResponse(ctx, DIR, get('/agg/'))).toBeNull();
		expect(assetResponse(ctx, DIR, get('/'))).toBeNull();
		expect(
			assetResponse(ctx, DIR, get('/robots.txt', { method: 'POST', body: 'x' }))
		).toBeNull();
	});

	it('never leaves the folder', () => {
		for (const path of [
			'/../secret.txt',
			'/agg/../../secret.txt',
			'/agg/%2e%2e/%2e%2e/secret.txt',
			'/%2e%2e/secret.txt',
			'/agg%2f..%2f..%2fsecret.txt',
			'/agg%5c..%5c..%5csecret.txt',
			'/robots.txt%00.png',
			'//robots.txt',
			'/agg//a.css',
			'/%E0%A4%A'
		]) {
			expect(
				assetResponse(ctx, DIR, new Request(`https://www.example.edu${path}`))
			).toBeNull();
		}
	});
});

describe('unixUpstream', () => {
	const route = { tenant: 'acme', site: 'www.example.edu' } as never;

	it('answers a placed file before the worker and sends everything else to the tenant socket', async () => {
		const dialled: string[] = [];
		const ctx: Context = {
			...ctxWith({ '/state/tenants/acme/assets/agg/a.css': 'body{}' }),
			fetch: (async (_url: string, init: { unix?: string }) => {
				dialled.push(init.unix!);
				return new Response('from the worker');
			}) as never
		};
		const upstream = unixUpstream(ctx, socketPaths('/state'));
		expect(await (await upstream(route, get('/agg/a.css'), '1.2.3.4')).text()).toBe('body{}');
		expect(dialled).toEqual([]);
		expect(await (await upstream(route, get('/node/1'), '1.2.3.4')).text()).toBe(
			'from the worker'
		);
		expect(dialled).toEqual(['/state/tenants/acme/http.sock']);
	});

	it('goes straight to the worker when the paths name no asset folder', async () => {
		let dialled = 0;
		const ctx: Context = {
			...ctxWith({ '/state/tenants/acme/assets/agg/a.css': 'body{}' }),
			fetch: (async () => {
				dialled += 1;
				return new Response('from the worker');
			}) as never
		};
		const upstream = unixUpstream(ctx, { socketFor: () => '/s.sock' });
		expect(await (await upstream(route, get('/agg/a.css'), 'c')).text()).toBe(
			'from the worker'
		);
		expect(dialled).toBe(1);
	});
});
