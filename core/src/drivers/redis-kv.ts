import { capabilities, type Capabilities } from '../adapters/capabilities';
import {
	assertCanHonour,
	isExpired,
	type KeyValueStore,
	type ListPage,
	type PutOptions,
	type StoredValue
} from '../adapters/store';
import type { Context } from '../context';

/**
 * The shape a redis or valkey client has to satisfy.
 *
 * Structural, and probed for the optional halves, because node-redis and ioredis spell the same
 * commands differently: `mGet` against `mget`, `pExpireAt` against `pexpireat`. bastion accepts
 * either rather than depending on one library, which is the contract style `CollegeDB` already
 * uses for exactly this reason. valkey is a redis fork speaking the same commands, so it is this
 * driver under another id rather than another implementation.
 */
export interface RedisLikeClient {
	get(key: string): Promise<string | Uint8Array | null>;
	set(key: string, value: string | Uint8Array, ...args: unknown[]): Promise<unknown>;
	del(...keys: string[]): Promise<number>;
	scan(
		cursor: string | number,
		...args: unknown[]
	): Promise<[string, string[]] | { cursor: string; keys: string[] }>;
	mGet?(keys: string[]): Promise<(string | Uint8Array | null)[]>;
	mget?(keys: string[]): Promise<(string | Uint8Array | null)[]>;
	pExpireAt?(key: string, at: number): Promise<unknown>;
	pexpireat?(key: string, at: number): Promise<unknown>;
	pTTL?(key: string): Promise<number>;
	pttl?(key: string): Promise<number>;
	ping?(): Promise<string>;
}

const PROBE_KEY = '__bastion_probe__';

function decodeScan(result: Awaited<ReturnType<RedisLikeClient['scan']>>): {
	cursor: string;
	keys: string[];
} {
	if (Array.isArray(result)) return { cursor: String(result[0]), keys: result[1] };
	return { cursor: String(result.cursor), keys: result.keys };
}

/**
 * Values in redis, with the binary question settled by a probe rather than by assumption.
 *
 * Some clients hand a value back as a `string` decoded as UTF-8, which silently mangles any byte
 * sequence that is not valid UTF-8 -- so a cached image comes back corrupt and nothing reports it.
 * The probe writes one non-UTF-8 byte and reads it back: when it survives, values ride raw; when it
 * does not, they ride base64 at a third more bytes. Conservative when the probe cannot run, like
 * every other capability.
 */
export function redisKv(
	ctx: Context,
	client: RedisLikeClient,
	id: 'redis' | 'valkey' = 'redis',
	prefix = 'bastion:'
): KeyValueStore & { probe(): Promise<void> } {
	let caps: Capabilities = capabilities({ ttl: true, batchDelete: true, pagedList: true });
	let binarySafe = false;
	let probed = false;
	let unreachable: string | null = null;

	const encode = (bytes: Uint8Array): string | Uint8Array =>
		binarySafe ? bytes : Buffer.from(bytes).toString('base64');
	const decode = (value: string | Uint8Array): Uint8Array => {
		if (typeof value !== 'string') return new Uint8Array(value);
		return binarySafe
			? new TextEncoder().encode(value)
			: new Uint8Array(Buffer.from(value, 'base64'));
	};

	const expireAt = async (key: string, at: number): Promise<void> => {
		const call = client.pExpireAt ?? client.pexpireat;
		if (call !== undefined) await call.call(client, key, at);
	};
	const ttlOf = async (key: string): Promise<number | null> => {
		const call = client.pTTL ?? client.pttl;
		if (call === undefined) return null;
		const ms = await call.call(client, key);
		return ms > 0 ? ctx.now() + ms : null;
	};

	const probe = async (): Promise<void> => {
		if (probed) return;
		probed = true;
		try {
			const sentinel = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
			await client.set(`${prefix}${PROBE_KEY}`, sentinel);
			const back = await client.get(`${prefix}${PROBE_KEY}`);
			const bytes =
				back === null
					? new Uint8Array()
					: typeof back === 'string'
						? new TextEncoder().encode(back)
						: new Uint8Array(back);
			binarySafe =
				bytes.length === 4 && bytes[0] === 0xff && bytes[1] === 0xfe && bytes[3] === 0x41;
			await client.del(`${prefix}${PROBE_KEY}`);
			caps = capabilities({
				ttl: (client.pExpireAt ?? client.pexpireat) !== undefined,
				batchDelete: true,
				pagedList: true
			});
			unreachable = null;
		} catch (e) {
			// a probe that could not run leaves the conservative answer in place
			unreachable = e instanceof Error ? e.message : String(e);
			binarySafe = false;
			caps = capabilities({ ttl: false, batchDelete: true, pagedList: true });
		}
	};

	return {
		probe,
		id: () => id,
		label: () => (id === 'redis' ? 'Redis' : 'Valkey'),
		capabilities: () => caps,
		isReachable: async () => {
			try {
				if (client.ping !== undefined) await client.ping();
				else await client.get(`${prefix}${PROBE_KEY}`);
				unreachable = null;
				return true;
			} catch (e) {
				unreachable = e instanceof Error ? e.message : String(e);
				return false;
			}
		},
		unreachableReason: () => unreachable,

		get: async (key) => {
			await probe();
			const raw = await client.get(`${prefix}${key}`);
			if (raw === null) return null;
			const value: StoredValue = {
				bytes: decode(raw),
				expiresAt: await ttlOf(`${prefix}${key}`)
			};
			return isExpired(value, ctx.now()) ? null : value;
		},

		put: async (key, bytes, options: PutOptions = {}) => {
			await probe();
			assertCanHonour(id, caps, options, bytes);
			await client.set(`${prefix}${key}`, encode(bytes));
			if (options.expiresAt !== undefined && options.expiresAt !== null) {
				await expireAt(`${prefix}${key}`, options.expiresAt);
			}
		},

		delete: async (keys) => {
			if (keys.length === 0) return 0;
			return client.del(...keys.map((k) => `${prefix}${k}`));
		},

		list: async (prefixFilter = '', cursor = null, limit = 1000): Promise<ListPage> => {
			await probe();
			const scanned = decodeScan(
				await client.scan(
					cursor ?? '0',
					'MATCH',
					`${prefix}${prefixFilter}*`,
					'COUNT',
					limit
				)
			);
			return {
				keys: scanned.keys.map((k) => ({ name: k.slice(prefix.length), expiresAt: null })),
				cursor: scanned.cursor === '0' ? null : scanned.cursor
			};
		}
	};
}
