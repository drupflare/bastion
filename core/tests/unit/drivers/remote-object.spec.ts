import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { remoteObjectStore, type RemoteFileClient } from '../../../src/drivers/remote-object';
import { memoryIo } from '../../../src/io';

function fakeClient(seed: Record<string, string> = {}, extras: Partial<RemoteFileClient> = {}) {
	const files = new Map<string, Uint8Array>();
	for (const [path, value] of Object.entries(seed))
		files.set(path, new TextEncoder().encode(value));
	const client: RemoteFileClient = {
		list: async (path) => {
			const prefix = `${path.replace(/\/$/, '')}/`;
			const seen = new Map<string, boolean>();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				const head = rest.split('/')[0] as string;
				seen.set(head, rest.includes('/'));
			}
			return [...seen].map(([name, directory]) => ({
				name,
				size: files.get(`${prefix}${name}`)?.length ?? 0,
				modifiedAt: 5,
				directory
			}));
		},
		get: async (path) => {
			const bytes = files.get(path);
			if (bytes === undefined) throw new Error(`no such file ${path}`);
			return bytes;
		},
		put: async (path, bytes) => {
			files.set(path, bytes);
		},
		delete: async (path) => {
			if (!files.delete(path)) throw new Error('missing');
		},
		...extras
	};
	return { client, files };
}

function store(client: RemoteFileClient, id: 'sftp' | 'ftp' = 'sftp') {
	const ctx = { ...defaultContext(), io: memoryIo(), env: {}, now: () => 7 };
	return remoteObjectStore(ctx, id, client, '/srv/backups');
}

describe('remoteObjectStore', () => {
	it('round trips through whatever client it was handed', async () => {
		const { client } = fakeClient();
		const s = store(client);
		await s.put('a/b', new TextEncoder().encode('hi'));
		expect(new TextDecoder().decode((await s.get('a/b'))?.bytes)).toBe('hi');
	});

	it('refuses a key that climbs out of the root', async () => {
		const { client } = fakeClient();
		await expect(store(client).get('../../etc/passwd')).rejects.toThrow(/climbs out/);
	});

	it('refuses metadata rather than dropping it, because the protocol cannot carry it', async () => {
		const { client } = fakeClient();
		await expect(
			store(client).put('a', new Uint8Array([1]), { customMetadata: { k: 'v' } })
		).rejects.toThrow(/will not drop it silently/);
	});

	it('refuses a conditional write rather than racing one', async () => {
		const { client } = fakeClient();
		await expect(
			store(client).put('a', new Uint8Array([1]), { ifAbsent: true })
		).rejects.toThrow(/conditionally/);
	});

	it('says it can do neither of those, so the engine never asks', () => {
		const { client } = fakeClient();
		const caps = store(client).capabilities();
		expect(caps.conditionalWrite).toBe(false);
		expect(caps.byteRange).toBe(false);
		expect(caps.ttl).toBe(false);
	});

	it('answers null for a missing key rather than raising', async () => {
		const { client } = fakeClient();
		expect(await store(client).get('nope')).toBe(null);
		expect(await store(client).head('nope')).toBe(null);
	});

	it('uses an optional stat when the client has one', async () => {
		const { client } = fakeClient(
			{ '/srv/backups/a': 'xyz' },
			{ stat: async () => ({ size: 3, modifiedAt: 99 }) }
		);
		expect(await store(client).head('a')).toEqual({
			key: 'a',
			size: 3,
			etag: '',
			uploadedAt: 99
		});
	});

	it('falls back to a read when the client has no stat', async () => {
		const { client } = fakeClient({ '/srv/backups/a': 'xyz' });
		expect((await store(client).head('a'))?.size).toBe(3);
	});

	it('creates the parent directory when the client can', async () => {
		const made: string[] = [];
		const { client } = fakeClient({}, { mkdir: async (p) => void made.push(p) });
		await store(client).put('deep/nested/a', new Uint8Array([1]));
		expect(made).toEqual(['/srv/backups/deep/nested']);
	});

	it('walks nested directories when listing', async () => {
		const { client } = fakeClient({
			'/srv/backups/site/a': '1',
			'/srv/backups/site/deep/b': '1',
			'/srv/backups/other/c': '1'
		});
		const page = await store(client).list('site/');
		expect(page.objects.map((o) => o.key)).toEqual(['site/a', 'site/deep/b']);
	});

	it('treats a delete of something already gone as done', async () => {
		const { client } = fakeClient({ '/srv/backups/a': '1' });
		const s = store(client);
		expect(await s.delete(['a'])).toBe(1);
		expect(await s.delete(['a'])).toBe(0);
	});

	it('reports unreachable with the reason the client gave', async () => {
		const { client } = fakeClient();
		const broken = {
			...client,
			list: async () => Promise.reject(new Error('connection refused'))
		};
		const s = store(broken as RemoteFileClient, 'ftp');
		expect(await s.isReachable()).toBe(false);
		expect(s.unreachableReason()).toContain('connection refused');
		expect(s.id()).toBe('ftp');
	});
});
