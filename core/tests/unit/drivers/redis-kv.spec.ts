import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { redisKv, type RedisLikeClient } from '../../../src/drivers/redis-kv';
import { memoryIo } from '../../../src/io';

/** a client that hands values back as a UTF-8 string, which is what node-redis does by default */
function stringClient(): RedisLikeClient & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		get: async (key) => store.get(key) ?? null,
		set: async (key, value) => {
			store.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value));
			return 'OK';
		},
		del: async (...keys) => {
			let n = 0;
			for (const key of keys) if (store.delete(key)) n++;
			return n;
		},
		scan: async (_cursor, ..._args) => ['0', [...store.keys()]] as [string, string[]],
		pExpireAt: async () => 1,
		pTTL: async () => -1
	};
}

/** a client that keeps bytes, which is what ioredis does in buffer mode */
function binaryClient(): RedisLikeClient {
	const store = new Map<string, Uint8Array>();
	return {
		get: async (key) => store.get(key) ?? null,
		set: async (key, value) => {
			store.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value);
			return 'OK';
		},
		del: async (...keys) => {
			let n = 0;
			for (const key of keys) if (store.delete(key)) n++;
			return n;
		},
		scan: async () => ({ cursor: '0', keys: [...store.keys()] }),
		pexpireat: async () => 1,
		pttl: async () => -1
	};
}

function ctx() {
	return { ...defaultContext(), io: memoryIo(), env: {}, now: () => 1000 };
}

const NON_UTF8 = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);

describe('redisKv', () => {
	it('round trips a value that is not valid UTF-8 through a string client', async () => {
		const store = redisKv(ctx(), stringClient());
		await store.put('k', NON_UTF8);
		expect(Array.from((await store.get('k'))?.bytes ?? [])).toEqual(Array.from(NON_UTF8));
	});

	it('round trips the same value through a binary client', async () => {
		const store = redisKv(ctx(), binaryClient());
		await store.put('k', NON_UTF8);
		expect(Array.from((await store.get('k'))?.bytes ?? [])).toEqual(Array.from(NON_UTF8));
	});

	it('probes once, so the binary question is asked a single time', async () => {
		const client = stringClient();
		let sets = 0;
		const counted = {
			...client,
			set: async (k: string, v: string | Uint8Array) => {
				sets++;
				return client.set(k, v);
			}
		};
		const store = redisKv(ctx(), counted);
		await store.put('a', new Uint8Array([1]));
		await store.put('b', new Uint8Array([2]));
		// one probe write plus the two real writes
		expect(sets).toBe(3);
	});

	it('accepts either spelling of the expiry command', async () => {
		const camel = redisKv(ctx(), stringClient());
		const lower = redisKv(ctx(), binaryClient());
		await camel.probe();
		await lower.probe();
		expect(camel.capabilities().ttl).toBe(true);
		expect(lower.capabilities().ttl).toBe(true);
	});

	it('reports no TTL when the client cannot expire, and then refuses one', async () => {
		const client = stringClient();
		const withoutTtl: RedisLikeClient = {
			get: client.get,
			set: client.set,
			del: client.del,
			scan: client.scan
		};
		const store = redisKv(ctx(), withoutTtl);
		await store.probe();
		expect(store.capabilities().ttl).toBe(false);
		await expect(store.put('k', new Uint8Array([1]), { expiresAt: 9999 })).rejects.toThrow(
			/will not drop it silently/
		);
	});

	it('stays conservative when the probe itself cannot run', async () => {
		const broken: RedisLikeClient = {
			get: async () => Promise.reject(new Error('down')),
			set: async () => Promise.reject(new Error('down')),
			del: async () => 0,
			scan: async () => ['0', []] as [string, string[]]
		};
		const store = redisKv(ctx(), broken);
		await store.probe();
		expect(store.capabilities().ttl).toBe(false);
	});

	it('namespaces keys, so two bastions on one redis do not collide', async () => {
		const client = stringClient();
		const store = redisKv(ctx(), client, 'redis', 'nodeA:');
		await store.put('k', new Uint8Array([1]));
		expect([...client.store.keys()]).toContain('nodeA:k');
	});

	it('strips the namespace back off when listing', async () => {
		const store = redisKv(ctx(), stringClient(), 'redis', 'nodeA:');
		await store.put('k', new Uint8Array([1]));
		const page = await store.list();
		expect(page.keys.map((k) => k.name)).toContain('k');
	});

	it('reads a cursor from either scan shape', async () => {
		expect((await redisKv(ctx(), stringClient()).list()).cursor).toBe(null);
		expect((await redisKv(ctx(), binaryClient()).list()).cursor).toBe(null);
	});

	it('labels valkey as itself rather than as redis', () => {
		expect(redisKv(ctx(), stringClient(), 'valkey').label()).toBe('Valkey');
		expect(redisKv(ctx(), stringClient(), 'valkey').id()).toBe('valkey');
	});

	it('reports unreachable with the reason', async () => {
		const broken: RedisLikeClient = {
			get: async () => Promise.reject(new Error('ECONNREFUSED')),
			set: async () => 'OK',
			del: async () => 0,
			scan: async () => ['0', []] as [string, string[]]
		};
		const store = redisKv(ctx(), broken);
		expect(await store.isReachable()).toBe(false);
		expect(store.unreachableReason()).toContain('ECONNREFUSED');
	});

	it('deletes nothing for an empty list rather than issuing a command', async () => {
		const store = redisKv(ctx(), stringClient());
		expect(await store.delete([])).toBe(0);
	});
});
