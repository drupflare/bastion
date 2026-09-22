import { beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '../../src/context';
import { s3ObjectStore } from '../../src/drivers/s3-object';
import { signRequest } from '../../src/drivers/sigv4';

/**
 * The s3 driver against a real minio.
 *
 * A mock of an object store tests bastion's belief about SigV4 rather than SigV4. drangler shipped
 * seven SQL converter bugs past a green unit suite for exactly that reason, and a signature is the
 * same class of thing: it is either byte-correct against the server or it is not, and only the
 * server can say.
 */
const ENDPOINT = process.env.BASTION_E2E_MINIO ?? 'http://127.0.0.1:19000';
const BUCKET = 'bastion-e2e';
const CREDENTIALS = {
	accessKeyId: process.env.BASTION_E2E_MINIO_KEY ?? 'bastion',
	secretAccessKey: process.env.BASTION_E2E_MINIO_SECRET ?? 'bastion-e2e-secret'
};

const enabled = process.env.REQUIRE_DOCKER === '1' || process.env.BASTION_E2E_INTEGRATION === '1';

const ctx = defaultContext();

function store() {
	return s3ObjectStore(ctx, 'minio', { bucket: BUCKET, endpoint: ENDPOINT, ...CREDENTIALS });
}

/** creates the bucket through bastion's own signer, so even the setup exercises the signing path */
async function createBucket(): Promise<void> {
	const url = new URL(`${ENDPOINT}/${BUCKET}`);
	const signed = signRequest(
		'PUT',
		url,
		{},
		new Uint8Array(0),
		{ ...CREDENTIALS, region: 'us-east-1', service: 's3' },
		Date.now()
	);
	const response = await fetch(url, { method: 'PUT', headers: signed.headers });
	// 409 BucketAlreadyOwnedByYou is the second run of this suite, which is not a failure
	if (!response.ok && response.status !== 409) {
		throw new Error(`minio refused the bucket: ${response.status} ${await response.text()}`);
	}
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe.skipIf(!enabled)('the s3 driver against a real minio', () => {
	beforeAll(async () => {
		await createBucket();
	});

	it('is reachable, and says so from the server rather than from configuration', async () => {
		expect(await store().isReachable()).toBe(true);
	});

	it('round-trips bytes a real server signed for', async () => {
		const driver = store();
		await driver.put('round-trip/one.txt', bytes('bastion e2e payload'));
		const body = await driver.get('round-trip/one.txt');
		expect(body).not.toBeNull();
		expect(text(body!.bytes)).toBe('bastion e2e payload');
	});

	it('answers a byte range with exactly that range', async () => {
		const driver = store();
		await driver.put('range/one.bin', bytes('0123456789'));
		const body = await driver.get('range/one.bin', { offset: 2, length: 4 });
		expect(text(body!.bytes)).toBe('2345');
	});

	it('reads back the length it wrote', async () => {
		const driver = store();
		await driver.put('meta/one.json', bytes('{"ok":true}'));
		const meta = await driver.head('meta/one.json');
		expect(meta?.size).toBe(11);
	});

	it('carries http metadata to the server and back', async () => {
		const driver = store();
		await driver.put('meta/typed.json', bytes('{"ok":true}'), {
			httpMetadata: { 'content-type': 'application/json' }
		});
		const response = await fetch(`${ENDPOINT}/${BUCKET}/meta/typed.json`, {
			method: 'HEAD',
			headers: signRequest(
				'HEAD',
				new URL(`${ENDPOINT}/${BUCKET}/meta/typed.json`),
				{},
				null,
				{ ...CREDENTIALS, region: 'us-east-1', service: 's3' },
				Date.now()
			).headers
		});
		expect(response.headers.get('content-type')).toBe('application/json');
	});

	it('answers null for a key that is not there rather than throwing', async () => {
		expect(await store().head('absent/nothing-here')).toBeNull();
		expect(await store().get('absent/nothing-here')).toBeNull();
	});

	it('lists under a prefix, parsing the real ListObjectsV2 XML', async () => {
		const driver = store();
		await driver.put('listing/a.txt', bytes('a'));
		await driver.put('listing/b.txt', bytes('b'));
		const page = await driver.list('listing/');
		expect(page.objects.map((object) => object.key).sort()).toEqual([
			'listing/a.txt',
			'listing/b.txt'
		]);
	});

	it('pages a listing through the real continuation token', async () => {
		const driver = store();
		for (const name of ['p1', 'p2', 'p3']) await driver.put(`paged/${name}.txt`, bytes(name));
		const first = await driver.list('paged/', null, 2);
		expect(first.objects).toHaveLength(2);
		expect(first.cursor).not.toBeNull();
		const second = await driver.list('paged/', first.cursor, 2);
		expect(second.objects.length).toBeGreaterThan(0);
	});

	it('deletes, and a deleted key reads back as absent', async () => {
		const driver = store();
		await driver.put('delete/one.txt', bytes('x'));
		expect(await driver.delete(['delete/one.txt'])).toBe(1);
		expect(await driver.head('delete/one.txt')).toBeNull();
	});

	it('signs a key containing characters the canonical form has to escape', async () => {
		const driver = store();
		const key = 'escaping/a b+c~d/e=f.txt';
		await driver.put(key, bytes('escaped'));
		expect(text((await driver.get(key))!.bytes)).toBe('escaped');
	});

	it('refuses a wrong secret with a real 403 rather than appearing to work', async () => {
		const wrong = s3ObjectStore(ctx, 'minio', {
			bucket: BUCKET,
			endpoint: ENDPOINT,
			accessKeyId: CREDENTIALS.accessKeyId,
			secretAccessKey: 'not-the-secret'
		});
		await expect(wrong.put('denied/one.txt', new Uint8Array([1]))).rejects.toThrow();
		expect(await wrong.isReachable()).toBe(false);
	});

	it('honours the conditional write it declares in its capabilities', async () => {
		const driver = store();
		const key = `conditional/${Date.now()}.txt`;
		await driver.put(key, bytes('first'), { ifAbsent: true });
		await expect(driver.put(key, bytes('second'), { ifAbsent: true })).rejects.toThrow(
			/already exists/
		);
		expect(text((await driver.get(key))!.bytes)).toBe('first');
	});

	it('round-trips a body larger than one TCP segment', async () => {
		const driver = store();
		const payload = new Uint8Array(512 * 1024).map((_, index) => index % 251);
		await driver.put('large/one.bin', payload);
		const body = await driver.get('large/one.bin');
		expect(body!.bytes.length).toBe(payload.length);
		expect(body!.bytes[payload.length - 1]).toBe(payload[payload.length - 1]);
	});

	it('round-trips bytes that are not valid UTF-8, so nothing is transcoding the body', async () => {
		const driver = store();
		const payload = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);
		await driver.put('binary/one.bin', payload);
		expect([...(await driver.get('binary/one.bin'))!.bytes]).toEqual([...payload]);
	});

	it('round-trips a zero-byte object, which is a different signature payload hash', async () => {
		const driver = store();
		await driver.put('empty/one.bin', new Uint8Array(0));
		expect((await driver.head('empty/one.bin'))?.size).toBe(0);
		expect((await driver.get('empty/one.bin'))!.bytes.length).toBe(0);
	});
});
