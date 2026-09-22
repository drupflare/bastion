import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { azureObjectStore, sharedKeyStringToSign } from '../../../src/drivers/azure-object';
import { memoryIo } from '../../../src/io';

const options = {
	account: 'acct',
	accountKey: Buffer.from('secret-key-bytes').toString('base64'),
	container: 'backups'
};

function harness(answer: () => Response) {
	const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(input),
			method: init?.method ?? 'GET',
			headers: (init?.headers ?? {}) as Record<string, string>
		});
		return answer();
	}) as unknown as typeof globalThis.fetch;
	return {
		ctx: { ...defaultContext(), fetch: fetcher, io: memoryIo(), env: {}, now: () => 0 },
		calls
	};
}

describe('sharedKeyStringToSign', () => {
	const headers = { 'x-ms-version': '2021-12-02', 'x-ms-date': 'Sat, 01 Jan 2026 00:00:00 GMT' };

	it('leaves Content-Length EMPTY for a bodyless request, not zero', () => {
		const text = sharedKeyStringToSign('GET', new URL('https://a/c/k'), headers, 'acct', 0);
		expect(text.split('\n')[3]).toBe('');
	});

	it('writes the length when there is a body', () => {
		const text = sharedKeyStringToSign('PUT', new URL('https://a/c/k'), headers, 'acct', 12);
		expect(text.split('\n')[3]).toBe('12');
	});

	it('sorts the x-ms headers', () => {
		const text = sharedKeyStringToSign(
			'GET',
			new URL('https://a/c/k'),
			{ 'x-ms-z': '1', 'x-ms-a': '2' },
			'acct',
			0
		);
		expect(text.indexOf('x-ms-a')).toBeLessThan(text.indexOf('x-ms-z'));
	});

	it('ends with the canonicalised resource, account first', () => {
		const text = sharedKeyStringToSign(
			'GET',
			new URL('https://a/backups/k'),
			headers,
			'acct',
			0
		);
		expect(text.endsWith('/acct/backups/k')).toBe(true);
	});

	it('appends sorted query parameters to the resource', () => {
		const text = sharedKeyStringToSign(
			'GET',
			new URL('https://a/backups?comp=list&restype=container'),
			headers,
			'acct',
			0
		);
		expect(text.endsWith('/acct/backups\ncomp:list\nrestype:container')).toBe(true);
	});
});

describe('azureObjectStore', () => {
	it('signs with SharedKey and names the account', async () => {
		const { ctx, calls } = harness(() => new Response('', { status: 200 }));
		await azureObjectStore(ctx, options).head('k');
		expect(calls[0]?.headers.authorization).toMatch(/^SharedKey acct:/);
	});

	it('declares the blob type on a put, which azure requires', async () => {
		const { ctx, calls } = harness(() => new Response('', { status: 201 }));
		await azureObjectStore(ctx, options).put('k', new Uint8Array([1]));
		expect(calls[0]?.headers['x-ms-blob-type']).toBe('BlockBlob');
	});

	it('reports a 409 on a conditional write as a refusal', async () => {
		const { ctx } = harness(() => new Response('', { status: 409 }));
		await expect(
			azureObjectStore(ctx, options).put('k', new Uint8Array([1]), { ifAbsent: true })
		).rejects.toThrow(/already exists/);
	});

	it('reads a blob listing and its marker', async () => {
		const xml =
			'<EnumerationResults><Blobs>' +
			'<Blob><Name>a</Name><Content-Length>5</Content-Length><Etag>e</Etag>' +
			'<Last-Modified>Thu, 01 Jan 2026 00:00:00 GMT</Last-Modified></Blob>' +
			'</Blobs><NextMarker>m1</NextMarker></EnumerationResults>';
		const { ctx } = harness(() => new Response(xml, { status: 200 }));
		const page = await azureObjectStore(ctx, options).list();
		expect(page.objects[0]?.key).toBe('a');
		expect(page.objects[0]?.size).toBe(5);
		expect(page.cursor).toBe('m1');
	});

	it('answers a null cursor when the marker is empty', async () => {
		const { ctx } = harness(
			() => new Response('<EnumerationResults><NextMarker></NextMarker></EnumerationResults>')
		);
		expect((await azureObjectStore(ctx, options).list()).cursor).toBe(null);
	});

	it('treats a 202 delete as removed, which is what azure answers', async () => {
		const { ctx } = harness(() => new Response('', { status: 202 }));
		expect(await azureObjectStore(ctx, options).delete(['a'])).toBe(1);
	});
});
