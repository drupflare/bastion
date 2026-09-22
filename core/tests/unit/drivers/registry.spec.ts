import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/defaults';
import { defaultContext } from '../../../src/context';
import {
	buildCache,
	buildKv,
	buildObjects,
	buildSql,
	DRIVERS,
	knownDriver
} from '../../../src/drivers/registry';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';

function ctx() {
	return { ...defaultContext(), files: memoryFiles(), io: memoryIo(), env: {}, now: () => 0 };
}

const scratch = () => mkdtempSync(join(tmpdir(), 'bastion-registry-'));

describe('DRIVERS', () => {
	it('lists every id the documented configuration offers', () => {
		expect(DRIVERS.r2).toContain('s3');
		expect(DRIVERS.r2).toContain('sftp');
		expect(DRIVERS.d1).toContain('mariadb');
		expect(DRIVERS.kv).toContain('valkey');
	});

	it('is what a config value is checked against, in one place', () => {
		expect(knownDriver('kv', 'redis')).toBe(true);
		expect(knownDriver('kv', 's3')).toBe(false);
	});

	it('names a driver for every adapter the default config configures', () => {
		const config = defaultConfig();
		for (const [adapter, driver] of Object.entries(config.drivers)) {
			expect(knownDriver(adapter as keyof typeof DRIVERS, driver.driver)).toBe(true);
		}
	});
});

describe('buildKv', () => {
	it('builds the in-memory driver', () => {
		expect(buildKv(ctx(), { driver: 'memory' }).id()).toBe('memory');
	});

	it('refuses redis without a client rather than choosing a library', () => {
		expect(() => buildKv(ctx(), { driver: 'redis' })).toThrow(/needs a client/);
	});

	it('refuses an unknown id', () => {
		expect(() => buildKv(ctx(), { driver: 'mongo' })).toThrow(/unknown kv driver/);
	});
});

describe('buildObjects', () => {
	it('builds the disk driver, which is what an operator gets by default', () => {
		expect(buildObjects(ctx(), { driver: 'fs', root: '/objects' }).id()).toBe('fs');
	});

	it('builds every S3-protocol flavour from one implementation', () => {
		for (const driver of ['s3', 'r2', 'b2', 'gcs', 'minio']) {
			const store = buildObjects(ctx(), {
				driver,
				bucket: 'b',
				accessKeyId: 'a',
				secretAccessKey: 's',
				endpoint: 'https://example.invalid'
			});
			expect(store.id()).toBe(driver);
		}
	});

	it('refuses sftp without a client', () => {
		expect(() => buildObjects(ctx(), { driver: 'sftp' })).toThrow(/needs a client/);
	});

	it('refuses an unknown id', () => {
		expect(() => buildObjects(ctx(), { driver: 'dropbox' })).toThrow(/unknown r2 driver/);
	});
});

describe('buildSql', () => {
	it('builds sqlite on disk, which needs no client', () => {
		const store = buildSql({ driver: 'sqlite', path: join(scratch(), 'd1.sqlite') });
		expect(store.dialect()).toBe('sqlite');
	});

	it('refuses a server dialect without a client', () => {
		expect(() => buildSql({ driver: 'postgres' })).toThrow(/needs a client/);
	});

	it('refuses an unknown id', () => {
		expect(() => buildSql({ driver: 'oracle' })).toThrow(/unknown d1 driver/);
	});
});

describe('buildCache', () => {
	it('builds the memory driver', () => {
		expect(buildCache(ctx(), { driver: 'memory' }).id()).toBe('memory');
	});

	it('puts a memory tier in front of disk, because fs alone is a read per request', () => {
		const store = buildCache(ctx(), {
			driver: 'fs',
			root: join(scratch(), 'cache.sqlite'),
			memoryTier: 1024
		});
		expect(store.id()).toBe('tiered(fs)');
	});

	it('refuses the null driver here, so it can never be built for serving traffic', () => {
		expect(() => buildCache(ctx(), { driver: 'null' })).toThrow(/not one bastion serves/);
	});
});
