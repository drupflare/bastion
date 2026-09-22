import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { parseListing, S3_FLAVOURS, s3ObjectStore } from '../../../src/drivers/s3-object';
import { memoryIo } from '../../../src/io';

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
}

function harness(answer: (call: Call) => Response) {
	const calls: Call[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const call: Call = {
			url: String(input),
			method: init?.method ?? 'GET',
			headers: (init?.headers ?? {}) as Record<string, string>
		};
		calls.push(call);
		return answer(call);
	}) as unknown as typeof globalThis.fetch;
	const ctx = { ...defaultContext(), fetch: fetcher, io: memoryIo(), env: {}, now: () => 0 };
	return { ctx, calls };
}

const options = {
	bucket: 'backups',
	accessKeyId: 'AK',
	secretAccessKey: 'SK',
	endpoint: 'https://acct.r2.cloudflarestorage.com'
};

describe('S3_FLAVOURS', () => {
	it('covers every S3-protocol id the config accepts', () => {
		expect(Object.keys(S3_FLAVOURS).sort()).toEqual(['b2', 'gcs', 'minio', 'r2', 's3']);
	});

	it('uses path addressing wherever virtual-host style is not available', () => {
		expect(S3_FLAVOURS.r2?.addressing).toBe('path');
		expect(S3_FLAVOURS.s3?.addressing).toBe('virtual');
	});
});

describe('s3ObjectStore', () => {
	it('signs every request, so no call leaves unauthenticated', async () => {
		const { ctx, calls } = harness(() => new Response('', { status: 200 }));
		const store = s3ObjectStore(ctx, 'r2', options);
		await store.head('k');
		expect(calls[0]?.headers.authorization).toContain('AWS4-HMAC-SHA256');
	});

	it('puts the bucket in the path for r2 and in the host for s3', async () => {
		const { ctx, calls } = harness(() => new Response('', { status: 200 }));
		await s3ObjectStore(ctx, 'r2', options).head('k');
		expect(calls[0]?.url).toBe('https://acct.r2.cloudflarestorage.com/backups/k');
		await s3ObjectStore(ctx, 's3', {
			...options,
			endpoint: undefined,
			region: 'us-east-1'
		}).head('k');
		expect(calls[1]?.url).toBe('https://backups.s3.us-east-1.amazonaws.com/k');
	});

	it('answers null for a 404 rather than raising', async () => {
		const { ctx } = harness(() => new Response('', { status: 404 }));
		const store = s3ObjectStore(ctx, 'r2', options);
		expect(await store.head('k')).toBe(null);
		expect(await store.get('k')).toBe(null);
	});

	it('refuses a short read rather than returning it', async () => {
		const { ctx } = harness(
			() => new Response('ab', { status: 200, headers: { 'content-length': '99' } })
		);
		await expect(s3ObjectStore(ctx, 'r2', options).get('k')).rejects.toThrow(/short read/);
	});

	it('sends a range header for a ranged read', async () => {
		const { ctx, calls } = harness(() => new Response('bc', { status: 206 }));
		await s3ObjectStore(ctx, 'r2', options).get('k', { offset: 1, length: 2 });
		expect(calls[0]?.headers.range).toBe('bytes=1-2');
	});

	it('turns a conditional put into if-none-match and reports a 412 as a refusal', async () => {
		const { ctx, calls } = harness(() => new Response('', { status: 412 }));
		const store = s3ObjectStore(ctx, 'r2', options);
		await expect(store.put('k', new Uint8Array([1]), { ifAbsent: true })).rejects.toThrow(
			/already exists/
		);
		expect(calls[0]?.headers['if-none-match']).toBe('*');
	});

	it('carries custom metadata as x-amz-meta headers', async () => {
		const { ctx, calls } = harness(() => new Response('', { status: 200 }));
		await s3ObjectStore(ctx, 'r2', options).put('k', new Uint8Array([1]), {
			customMetadata: { site: 'acme' }
		});
		expect(calls[0]?.headers['x-amz-meta-site']).toBe('acme');
	});

	it('reports a 5xx as unreachable rather than as a missing object', async () => {
		const { ctx } = harness(() => new Response('', { status: 503 }));
		const store = s3ObjectStore(ctx, 'r2', options);
		expect(await store.isReachable()).toBe(false);
		expect(store.unreachableReason()).toContain('503');
	});

	it('refuses a flavour it does not know rather than guessing an endpoint', () => {
		const { ctx } = harness(() => new Response(''));
		expect(() => s3ObjectStore(ctx, 'wasabi', options)).toThrow(/unknown object driver/);
	});
});

describe('parseListing', () => {
	const xml = `<?xml version="1.0"?><ListBucketResult>
		<IsTruncated>true</IsTruncated>
		<NextContinuationToken>tok</NextContinuationToken>
		<Contents><Key>a/1</Key><Size>10</Size><ETag>"e1"</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>
		<Contents><Key>a/2</Key><Size>20</Size><ETag>"e2"</ETag><LastModified>2026-01-02T00:00:00.000Z</LastModified></Contents>
	</ListBucketResult>`;

	it('reads every object out of a listing', () => {
		const page = parseListing(xml);
		expect(page.objects.map((o) => o.key)).toEqual(['a/1', 'a/2']);
		expect(page.objects[0]?.size).toBe(10);
	});

	it('carries the continuation token only while the listing is truncated', () => {
		expect(parseListing(xml).cursor).toBe('tok');
		expect(parseListing(xml.replace('true', 'false')).cursor).toBe(null);
	});

	it('answers an empty page for an empty listing', () => {
		expect(parseListing('<ListBucketResult></ListBucketResult>')).toEqual({
			objects: [],
			cursor: null
		});
	});
});
