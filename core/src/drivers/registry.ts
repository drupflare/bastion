import type { CacheStore } from '../adapters/cache';
import { memoryCacheStore, tieredCache } from '../adapters/cache';
import type { ObjectStore } from '../adapters/objects';
import type { SqlClient, SqlDialect, SqlStore } from '../adapters/sql';
import type { KeyValueStore } from '../adapters/store';
import type { Context } from '../context';
import { BastionError } from '../errors';
import { azureObjectStore, type AzureOptions } from './azure-object';
import { fsCacheStore } from './fs-cache';
import { fsObjectStore } from './fs-object';
import { memoryKv } from './memory-kv';
import { redisKv, type RedisLikeClient } from './redis-kv';
import { remoteObjectStore, type RemoteFileClient } from './remote-object';
import { S3_FLAVOURS, s3ObjectStore, type S3Options } from './s3-object';
import { sqlStore } from './sql-store';
import { sqliteKv } from './sqlite-kv';
import { sqliteClient } from './sqlite-sql';

/** every driver id bastion knows, per adapter, and the single place a config value is checked */
export const DRIVERS = {
	cache: ['fs', 'memory', 'null'],
	kv: ['sqlite', 'memory', 'redis', 'valkey'],
	r2: ['fs', 's3', 'r2', 'azure', 'gcs', 'b2', 'sftp', 'ftp', 'minio'],
	d1: ['sqlite', 'postgres', 'mysql', 'mariadb'],
	queues: ['sqlite', 'memory'],
	secrets: ['keyring', 'env', 'file', 'kms']
} as const;

export type Adapter = keyof typeof DRIVERS;

export function knownDriver(adapter: Adapter, id: string): boolean {
	return (DRIVERS[adapter] as readonly string[]).includes(id);
}

/**
 * Clients an operator supplies for the drivers bastion refuses to depend on a library for.
 *
 * redis, sftp, ftp and the three SQL servers are reached through a client the caller brings, which
 * is what keeps `@drupflare/bastion` free of a dependency tree that would otherwise be six clients
 * wide and would decide the operator's version of each one.
 */
export interface DriverClients {
	redis?: RedisLikeClient;
	valkey?: RedisLikeClient;
	sftp?: RemoteFileClient;
	ftp?: RemoteFileClient;
	sql?: SqlClient;
}

function need<T>(value: T | undefined, adapter: string, id: string): T {
	if (value === undefined) {
		throw new BastionError(
			'driver-refused',
			`the ${id} ${adapter} driver needs a client; pass one in DriverClients rather than ` +
				'having bastion choose a library for you'
		);
	}
	return value;
}

export function buildKv(
	ctx: Context,
	config: { driver: string; [key: string]: unknown },
	clients: DriverClients = {}
): KeyValueStore {
	switch (config.driver) {
		case 'memory':
			return memoryKv(ctx.now);
		case 'sqlite':
			return sqliteKv(String(config.path ?? '/var/lib/bastion/kv.sqlite'), { now: ctx.now });
		case 'redis':
			return redisKv(ctx, need(clients.redis, 'kv', 'redis'), 'redis');
		case 'valkey':
			return redisKv(ctx, need(clients.valkey ?? clients.redis, 'kv', 'valkey'), 'valkey');
		default:
			throw new BastionError('driver-refused', `unknown kv driver ${config.driver}`);
	}
}

export function buildObjects(
	ctx: Context,
	config: { driver: string; [key: string]: unknown },
	clients: DriverClients = {}
): ObjectStore {
	if (config.driver === 'fs') {
		return fsObjectStore(ctx, String(config.root ?? '/var/lib/bastion/objects'));
	}
	if (config.driver === 'azure') return azureObjectStore(ctx, config as unknown as AzureOptions);
	if (config.driver === 'sftp' || config.driver === 'ftp') {
		return remoteObjectStore(
			ctx,
			config.driver,
			need(clients[config.driver], 'r2', config.driver),
			String(config.root ?? '/')
		);
	}
	if (config.driver in S3_FLAVOURS) {
		return s3ObjectStore(ctx, config.driver, config as unknown as S3Options);
	}
	throw new BastionError('driver-refused', `unknown r2 driver ${config.driver}`);
}

export function buildSql(
	config: { driver: string; [key: string]: unknown },
	clients: DriverClients = {}
): SqlStore {
	if (config.driver === 'sqlite') {
		return sqlStore(
			'sqlite',
			sqliteClient(String(config.path ?? '/var/lib/bastion/d1.sqlite'))
		);
	}
	if ((['postgres', 'mysql', 'mariadb'] as string[]).includes(config.driver)) {
		return sqlStore(config.driver as SqlDialect, need(clients.sql, 'd1', config.driver));
	}
	throw new BastionError('driver-refused', `unknown d1 driver ${config.driver}`);
}

export function buildCache(
	ctx: Context,
	config: { driver: string; [key: string]: unknown }
): CacheStore {
	const memoryTier = Number(config.memoryTier ?? 256 * 1024 * 1024);
	if (config.driver === 'memory') return memoryCacheStore(ctx.now);
	if (config.driver === 'fs') {
		return tieredCache(
			fsCacheStore(String(config.root ?? '/var/lib/bastion/cache.sqlite'), ctx.now),
			{
				memoryBytes: memoryTier,
				now: ctx.now
			}
		);
	}
	throw new BastionError(
		'driver-refused',
		`the ${config.driver} cache driver is not one bastion serves traffic from`
	);
}
