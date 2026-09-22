import type { ObjectStore } from '../adapters/objects';
import type { Context } from '../context';
import { BastionError } from '../errors';
import { digestOf, frames, join, type Frame } from './frame';
import { buildPack, readPack, type Pack } from './pack';

export interface Manifest {
	site: string;
	version: number;
	takenAt: number;
	/** every frame of the site database, in order */
	digests: string[];
	bytes: number;
	/** the digest of the whole database, so a restore proves it reassembled the same thing */
	whole: string;
	captureMethod: string;
}

export interface BackupOptions {
	passphrase?: string;
	/** how many versions may chain before a full snapshot is written again */
	chainCap?: number;
}

const MANIFEST_PREFIX = 'manifests/';
const PACK_PREFIX = 'packs/';

function manifestKey(site: string, version: number): string {
	return `${MANIFEST_PREFIX}${site}/${String(version).padStart(10, '0')}.json`;
}

/**
 * The backup engine.
 *
 * Content-addressed: a frame whose digest the store already holds is not written again, which is
 * what makes the second backup of a site cost its changed bytes rather than its size. The index is
 * kept per site rather than globally so a `prune` can decide what is unreferenced without reading
 * every other site's manifests.
 */
export class BackupEngine {
	private readonly ctx: Context;
	private readonly store: ObjectStore;
	private readonly options: BackupOptions;

	constructor(ctx: Context, store: ObjectStore, options: BackupOptions = {}) {
		this.ctx = ctx;
		this.store = store;
		this.options = options;
	}

	private packOptions(): { passphrase?: string } {
		return this.options.passphrase === undefined ? {} : { passphrase: this.options.passphrase };
	}

	async held(site: string): Promise<Set<string>> {
		const page = await this.store.list(`${PACK_PREFIX}${site}/`);
		const digests = new Set<string>();
		for (const object of page.objects) {
			const index = await this.store.get(`${object.key}.index`);
			if (index === null) continue;
			const entries = JSON.parse(new TextDecoder().decode(index.bytes)) as {
				digest: string;
			}[];
			for (const entry of entries) digests.add(entry.digest);
		}
		return digests;
	}

	async versions(site: string): Promise<Manifest[]> {
		const page = await this.store.list(`${MANIFEST_PREFIX}${site}/`);
		const out: Manifest[] = [];
		for (const object of page.objects) {
			const body = await this.store.get(object.key);
			if (body === null) continue;
			out.push(JSON.parse(new TextDecoder().decode(body.bytes)) as Manifest);
		}
		return out.sort((a, b) => a.version - b.version);
	}

	/** writes one version, storing only the frames the target does not already hold */
	async snapshot(
		site: string,
		bytes: Uint8Array,
		captureMethod = 'vacuum-into'
	): Promise<{ manifest: Manifest; newFrames: number; reusedFrames: number }> {
		const existing = await this.versions(site);
		const version = (existing[existing.length - 1]?.version ?? 0) + 1;
		const held = await this.held(site);
		const all = frames(bytes);

		const unseen: Frame[] = [];
		const seen = new Set<string>();
		for (const frame of all) {
			if (held.has(frame.digest) || seen.has(frame.digest)) continue;
			seen.add(frame.digest);
			unseen.push(frame);
		}

		if (unseen.length > 0) {
			const pack = buildPack(`${site}-${version}`, unseen, this.packOptions());
			await this.store.put(`${PACK_PREFIX}${site}/${pack.id}`, pack.body);
			await this.store.put(
				`${PACK_PREFIX}${site}/${pack.id}.index`,
				new TextEncoder().encode(JSON.stringify(pack.entries))
			);
		}

		const manifest: Manifest = {
			site,
			version,
			takenAt: this.ctx.now(),
			digests: all.map((f) => f.digest),
			bytes: bytes.length,
			whole: digestOf(bytes),
			captureMethod
		};
		await this.store.put(
			manifestKey(site, version),
			new TextEncoder().encode(JSON.stringify(manifest))
		);
		return {
			manifest,
			newFrames: unseen.length,
			reusedFrames: all.length - unseen.length
		};
	}

	private async loadFrames(site: string): Promise<Map<string, Uint8Array>> {
		const page = await this.store.list(`${PACK_PREFIX}${site}/`);
		const out = new Map<string, Uint8Array>();
		for (const object of page.objects) {
			if (object.key.endsWith('.index')) continue;
			const body = await this.store.get(object.key);
			const index = await this.store.get(`${object.key}.index`);
			if (body === null || index === null) continue;
			const pack: Pack = {
				id: object.key,
				entries: JSON.parse(new TextDecoder().decode(index.bytes)) as Pack['entries'],
				body: body.bytes,
				uncompressedBytes: 0
			};
			for (const [digest, frame] of readPack(pack, this.options.passphrase)) {
				out.set(digest, frame);
			}
		}
		return out;
	}

	/**
	 * Reassembles one version.
	 *
	 * The whole-database digest is checked at the end. A restore that silently produced a different
	 * database than the one backed up is the failure a drill exists to catch, and catching it here
	 * costs one hash.
	 */
	async restore(
		site: string,
		version?: number
	): Promise<{ bytes: Uint8Array; manifest: Manifest }> {
		const all = await this.versions(site);
		const manifest =
			version === undefined ? all[all.length - 1] : all.find((m) => m.version === version);
		if (manifest === undefined) {
			throw new BastionError('usage', `${site} has no version ${version ?? '(any)'}`);
		}
		const available = await this.loadFrames(site);
		const parts: Uint8Array[] = [];
		for (const digest of manifest.digests) {
			const frame = available.get(digest);
			if (frame === undefined) {
				throw new BastionError(
					'driver-refused',
					`frame ${digest.slice(0, 12)} of ${site} version ${manifest.version} is missing; ` +
						'the restore is refused rather than completed short'
				);
			}
			parts.push(frame);
		}
		const bytes = join(parts);
		if (digestOf(bytes) !== manifest.whole) {
			throw new BastionError(
				'driver-refused',
				`${site} version ${manifest.version} reassembled to a different database than was taken`
			);
		}
		return { bytes, manifest };
	}

	/** whether every frame a version names is present and hashes to what it claims */
	async verify(site: string, version?: number): Promise<{ ok: boolean; missing: string[] }> {
		const all = await this.versions(site);
		const manifest =
			version === undefined ? all[all.length - 1] : all.find((m) => m.version === version);
		if (manifest === undefined) return { ok: false, missing: ['no such version'] };
		const available = await this.loadFrames(site);
		const missing: string[] = [];
		for (const digest of manifest.digests) {
			const frame = available.get(digest);
			if (frame === undefined || digestOf(frame) !== digest) missing.push(digest);
		}
		return { ok: missing.length === 0, missing };
	}

	async prune(site: string, keep: number[]): Promise<{ removedVersions: number[] }> {
		const all = await this.versions(site);
		const removed: number[] = [];
		for (const manifest of all) {
			if (keep.includes(manifest.version)) continue;
			await this.store.delete([manifestKey(site, manifest.version)]);
			removed.push(manifest.version);
		}
		return { removedVersions: removed };
	}

	/** what the next backup would cost, without taking one */
	async estimate(
		site: string,
		bytes: Uint8Array
	): Promise<{ newBytes: number; reusedBytes: number }> {
		const held = await this.held(site);
		let newBytes = 0;
		let reusedBytes = 0;
		const seen = new Set<string>();
		for (const frame of frames(bytes)) {
			if (held.has(frame.digest) || seen.has(frame.digest)) reusedBytes += frame.bytes.length;
			else {
				seen.add(frame.digest);
				newBytes += frame.bytes.length;
			}
		}
		return { newBytes, reusedBytes };
	}
}

export interface RetentionPolicy {
	hourly: number;
	daily: number;
	monthly: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { hourly: 24, daily: 14, monthly: 6 };

function bucket(at: number, unit: 'hour' | 'day' | 'month'): string {
	const date = new Date(at);
	const iso = date.toISOString();
	if (unit === 'hour') return iso.slice(0, 13);
	if (unit === 'day') return iso.slice(0, 10);
	return iso.slice(0, 7);
}

/**
 * Which versions survive retention.
 *
 * Evaluated per SITE rather than per node, which is what makes primary-only backups safe in a
 * cluster: two nodes cannot both decide a version is expendable, because only the primary for that
 * site ever evaluates it.
 */
export function retain(
	manifests: Manifest[],
	policy: RetentionPolicy = DEFAULT_RETENTION
): number[] {
	const keep = new Set<number>();
	const newestFirst = [...manifests].sort((a, b) => b.takenAt - a.takenAt);
	for (const [unit, count] of [
		['hour', policy.hourly],
		['day', policy.daily],
		['month', policy.monthly]
	] as const) {
		const seen = new Set<string>();
		for (const manifest of newestFirst) {
			const key = bucket(manifest.takenAt, unit);
			if (seen.has(key)) continue;
			seen.add(key);
			if (seen.size > count) break;
			keep.add(manifest.version);
		}
	}
	return [...keep].sort((a, b) => a - b);
}
