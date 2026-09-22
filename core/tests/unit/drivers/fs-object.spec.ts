import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { fsObjectStore, objectPath } from '../../../src/drivers/fs-object';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';

function store(now = () => 1000) {
	const files = memoryFiles();
	const ctx = { ...defaultContext(), files, io: memoryIo(), env: {}, now };
	return { store: fsObjectStore(ctx, '/objects'), files };
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('objectPath', () => {
	it('refuses a key that climbs out of the root', () => {
		expect(() => objectPath('/objects', '../etc/passwd')).toThrow(/refuses the key/);
		expect(() => objectPath('/objects', 'a/../../b')).toThrow(/refuses the key/);
	});

	it('refuses an absolute or empty key', () => {
		expect(() => objectPath('/objects', '/etc/passwd')).toThrow();
		expect(() => objectPath('/objects', '')).toThrow();
	});

	it('allows an ordinary nested key', () => {
		expect(objectPath('/objects', 'site/a.sqlite')).toBe('/objects/site/a.sqlite');
	});
});

describe('fsObjectStore', () => {
	it('round trips an object with its metadata', async () => {
		const { store: s } = store();
		await s.put('a/b.bin', bytes('hello'), { customMetadata: { origin: 'acme' } });
		const got = await s.get('a/b.bin');
		expect(new TextDecoder().decode(got?.bytes)).toBe('hello');
		expect(got?.meta.customMetadata).toEqual({ origin: 'acme' });
		expect(got?.meta.uploadedAt).toBe(1000);
	});

	it('answers null for an absent key rather than raising', async () => {
		const { store: s } = store();
		expect(await s.get('missing')).toBe(null);
		expect(await s.head('missing')).toBe(null);
	});

	it('refuses a conditional write when the key is there', async () => {
		const { store: s } = store();
		await s.put('a', bytes('1'));
		await expect(s.put('a', bytes('2'), { ifAbsent: true })).rejects.toThrow(/already exists/);
	});

	it('serves a byte range', async () => {
		const { store: s } = store();
		await s.put('a', bytes('0123456789'));
		const got = await s.get('a', { offset: 2, length: 3 });
		expect(new TextDecoder().decode(got?.bytes)).toBe('234');
		expect(got?.meta.size).toBe(10);
	});

	it('deletes the sidecar with the object, so metadata cannot outlive it', async () => {
		const { store: s, files } = store();
		await s.put('a', bytes('1'), { customMetadata: { k: 'v' } });
		expect(await s.delete(['a'])).toBe(1);
		expect(files.exists('/objects/a')).toBe(false);
		expect(files.exists('/objects/a.meta.json')).toBe(false);
	});

	it('counts only what it removed, so a second delete is idempotent', async () => {
		const { store: s } = store();
		await s.put('a', bytes('1'));
		expect(await s.delete(['a', 'b'])).toBe(1);
		expect(await s.delete(['a'])).toBe(0);
	});

	it('lists by prefix, sorted, and does not list the sidecars', async () => {
		const { store: s } = store();
		await s.put('site/b', bytes('1'));
		await s.put('site/a', bytes('1'));
		await s.put('other/c', bytes('1'));
		const page = await s.list('site/');
		expect(page.objects.map((o) => o.key)).toEqual(['site/a', 'site/b']);
	});

	it('pages with a cursor that resumes after the last key', async () => {
		const { store: s } = store();
		for (const key of ['a', 'b', 'c', 'd']) await s.put(key, bytes('1'));
		const first = await s.list('', null, 2);
		expect(first.objects.map((o) => o.key)).toEqual(['a', 'b']);
		expect(first.cursor).toBe('b');
		const second = await s.list('', first.cursor, 2);
		expect(second.objects.map((o) => o.key)).toEqual(['c', 'd']);
		expect(second.cursor).toBe(null);
	});

	it('reports the capabilities the engine branches on', async () => {
		const { store: s } = store();
		expect(s.capabilities().conditionalWrite).toBe(true);
		expect(s.capabilities().byteRange).toBe(true);
		expect(await s.isReachable()).toBe(true);
		expect(s.unreachableReason()).toBe(null);
		expect(s.id()).toBe('fs');
		expect(s.label()).toContain('/objects');
	});
});
