import { describe, expect, it } from 'vitest';
import { capture } from '../../../src/backup/capture';
import { BackupEngine, DEFAULT_RETENTION, retain, type Manifest } from '../../../src/backup/engine';
import { digestOf, FRAME_BYTES, frames } from '../../../src/backup/frame';
import {
	buildPack,
	COMPACTION_LEVEL,
	HOT_LEVEL,
	readPack,
	recompress,
	seal,
	unseal
} from '../../../src/backup/pack';
import { defaultContext } from '../../../src/context';
import { fsObjectStore } from '../../../src/drivers/fs-object';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';

function harness(now = () => 1000) {
	const files = memoryFiles();
	const ctx = { ...defaultContext(), files, io: memoryIo(), env: {}, now };
	const store = fsObjectStore(ctx, '/backups');
	return { ctx, files, store, engine: new BackupEngine(ctx, store, { passphrase: 'key' }) };
}

/** a database-shaped buffer: mostly stable pages with a changing region */
function database(seed: number, size = FRAME_BYTES * 8): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = (i * 31) % 251;
	for (let i = 0; i < FRAME_BYTES; i++) bytes[i] = (i + seed) % 256;
	return bytes;
}

describe('framing', () => {
	it('cuts at a fixed 16 KiB, which aligns with SQLite pages', () => {
		expect(FRAME_BYTES).toBe(16384);
		expect(frames(new Uint8Array(FRAME_BYTES * 2 + 5))).toHaveLength(3);
	});

	it('gives an identical region an identical digest, which is what makes dedup work', () => {
		const a = frames(database(1));
		const b = frames(database(2));
		expect(a[0]?.digest).not.toBe(b[0]?.digest);
		expect(a[3]?.digest).toBe(b[3]?.digest);
	});

	it('produces no frames for an empty database', () => {
		expect(frames(new Uint8Array(0))).toEqual([]);
	});
});

describe('packs', () => {
	it('round trips through zstd and the seal', () => {
		const pack = buildPack('p1', frames(database(1)), { passphrase: 'key' });
		const back = readPack(pack, 'key');
		for (const frame of frames(database(1))) {
			expect(back.get(frame.digest)).toBeDefined();
		}
	});

	it('refuses to build without a key rather than writing databases in the clear', () => {
		expect(() => buildPack('p1', frames(database(1)), { passphrase: null })).toThrow(
			/backups are encrypted/
		);
	});

	it('refuses to open with the wrong key', () => {
		const sealed = seal(new Uint8Array([1, 2, 3]), 'right');
		expect(() => unseal(sealed, 'wrong')).toThrow(/did not open/);
		expect(Array.from(unseal(sealed, 'right'))).toEqual([1, 2, 3]);
	});

	it('compresses on the hot path at level 1 and in compaction at 19', () => {
		expect(HOT_LEVEL).toBe(1);
		expect(COMPACTION_LEVEL).toBe(19);
	});

	it('recompresses a whole pack rather than single frames', () => {
		const pack = buildPack('p1', frames(database(1)), { passphrase: 'key' });
		const tighter = recompress(pack, 'key');
		expect(tighter.entries).toHaveLength(pack.entries.length);
		expect(readPack(tighter, 'key').size).toBe(readPack(pack, 'key').size);
	});
});

describe('BackupEngine', () => {
	it('stores a first version whole', async () => {
		const { engine } = harness();
		const result = await engine.snapshot('acme', database(1));
		expect(result.manifest.version).toBe(1);
		expect(result.newFrames).toBe(8);
		expect(result.reusedFrames).toBe(0);
	});

	it('stores only the changed frames on the second version', async () => {
		const { engine } = harness();
		await engine.snapshot('acme', database(1));
		const second = await engine.snapshot('acme', database(2));
		expect(second.manifest.version).toBe(2);
		expect(second.newFrames).toBe(1);
		expect(second.reusedFrames).toBe(7);
	});

	it('restores each version to exactly the bytes it was given', async () => {
		const { engine } = harness();
		await engine.snapshot('acme', database(1));
		await engine.snapshot('acme', database(2));
		expect(Array.from((await engine.restore('acme', 1)).bytes)).toEqual(
			Array.from(database(1))
		);
		expect(Array.from((await engine.restore('acme', 2)).bytes)).toEqual(
			Array.from(database(2))
		);
	});

	it('restores the newest version when none is named', async () => {
		const { engine } = harness();
		await engine.snapshot('acme', database(1));
		await engine.snapshot('acme', database(2));
		expect((await engine.restore('acme')).manifest.version).toBe(2);
	});

	it('refuses a restore rather than completing it short', async () => {
		const { engine, store } = harness();
		await engine.snapshot('acme', database(1));
		const packs = await store.list('packs/acme/');
		await store.delete([packs.objects.filter((o) => !o.key.endsWith('.index'))[0]?.key ?? '']);
		await expect(engine.restore('acme', 1)).rejects.toThrow(
			/refused rather than completed short/
		);
	});

	it('verifies every frame a version names', async () => {
		const { engine } = harness();
		await engine.snapshot('acme', database(1));
		expect(await engine.verify('acme', 1)).toEqual({ ok: true, missing: [] });
	});

	it('reports a verify of a version that does not exist as not ok', async () => {
		const { engine } = harness();
		expect((await engine.verify('acme', 9)).ok).toBe(false);
	});

	it('refuses to restore a version that does not exist', async () => {
		const { engine } = harness();
		await expect(engine.restore('acme', 9)).rejects.toThrow(/no version/);
	});

	it('estimates the next backup without taking one', async () => {
		const { engine, store } = harness();
		await engine.snapshot('acme', database(1));
		const before = (await store.list('manifests/acme/')).objects.length;
		const estimate = await engine.estimate('acme', database(2));
		expect(estimate.newBytes).toBe(FRAME_BYTES);
		expect(estimate.reusedBytes).toBe(FRAME_BYTES * 7);
		expect((await store.list('manifests/acme/')).objects).toHaveLength(before);
	});

	it('prunes the versions retention did not keep', async () => {
		const { engine } = harness();
		await engine.snapshot('acme', database(1));
		await engine.snapshot('acme', database(2));
		expect(await engine.prune('acme', [2])).toEqual({ removedVersions: [1] });
		expect(await engine.versions('acme')).toHaveLength(1);
	});

	it('records which capture method produced the bytes', async () => {
		const { engine } = harness();
		const result = await engine.snapshot('acme', database(1), 'quiesced-copy');
		expect(result.manifest.captureMethod).toBe('quiesced-copy');
	});
});

describe('retain', () => {
	const manifest = (version: number, takenAt: number): Manifest => ({
		site: 'acme',
		version,
		takenAt,
		digests: [],
		bytes: 0,
		whole: digestOf(new Uint8Array()),
		captureMethod: 'vacuum-into'
	});
	const HOUR = 3_600_000;

	it('keeps one per hour up to the hourly count', () => {
		const versions = [1, 2, 3, 4].map((n) => manifest(n, n * HOUR));
		const kept = retain(versions, { hourly: 2, daily: 0, monthly: 0 });
		expect(kept).toEqual([3, 4]);
	});

	it('keeps nothing when every count is zero', () => {
		expect(retain([manifest(1, 0)], { hourly: 0, daily: 0, monthly: 0 })).toEqual([]);
	});

	it('defaults to a day of hourlies, a fortnight of dailies and six months', () => {
		expect(DEFAULT_RETENTION).toEqual({ hourly: 24, daily: 14, monthly: 6 });
	});
});

describe('capture', () => {
	it('prefers VACUUM INTO where the database is reachable', async () => {
		const files = memoryFiles({ '/db.sqlite': 'live' });
		const ctx = { ...defaultContext(), files, io: memoryIo(), env: {} };
		const result = await capture(ctx, {
			source: '/db.sqlite',
			staging: '/staging.sqlite',
			vacuumInto: (_s, d) => files.writeText(d, 'consistent'),
			onlineBackup: () => {
				throw new Error('should not be reached');
			}
		});
		expect(result.method).toBe('vacuum-into');
	});

	it('copies the WAL and the shm with the database when it has to quiesce', async () => {
		const files = memoryFiles({
			'/db.sqlite': 'live',
			'/db.sqlite-wal': 'log',
			'/db.sqlite-shm': 'index'
		});
		const ctx = { ...defaultContext(), files, io: memoryIo(), env: {} };
		let stopped = false;
		const result = await capture(ctx, {
			source: '/db.sqlite',
			staging: '/staging.sqlite',
			quiesce: async (run) => {
				stopped = true;
				run();
			}
		});
		expect(stopped).toBe(true);
		expect(result.method).toBe('quiesced-copy');
		expect(files.readText('/staging.sqlite-wal')).toBe('log');
	});

	it('refuses a plain copy of a live database rather than producing a corrupt one', async () => {
		const files = memoryFiles({ '/db.sqlite': 'live' });
		const ctx = { ...defaultContext(), files, io: memoryIo(), env: {} };
		await expect(capture(ctx, { source: '/db.sqlite', staging: '/s' })).rejects.toThrow(
			/would be corrupt/
		);
	});

	it('refuses a source that is not there', async () => {
		const ctx = { ...defaultContext(), files: memoryFiles(), io: memoryIo(), env: {} };
		await expect(capture(ctx, { source: '/gone', staging: '/s' })).rejects.toThrow(/not there/);
	});
});
