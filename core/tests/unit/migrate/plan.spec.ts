import { describe, expect, it } from 'vitest';
import { capacity, defaultCostModel, type HostReading } from '../../../src/capacity/model';
import { defaultContext } from '../../../src/context';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import {
	CARRY_TABLE,
	assertPlanFits,
	buildPlan,
	type DiscoveredSite
} from '../../../src/migrate/plan';
import { MigrationRun, refuseDirectSeed, type MigrationHooks } from '../../../src/migrate/run';

const GiB = 1024 ** 3;
const host: HostReading = {
	cores: 8,
	memoryBytes: 16 * GiB,
	diskBytes: 500 * GiB,
	diskFreeBytes: 400 * GiB,
	terms: []
};
const answer = capacity(host, defaultCostModel('solo'), { residency: 'evict', tenants: 1 });

const site = (host: string): DiscoveredSite => ({
	host,
	source: 'vps',
	sizeBytes: 5 * 1024 * 1024,
	cms: 'drupal',
	warnings: []
});

function plan(discovered: DiscoveredSite[], maxSites?: number) {
	return buildPlan({
		source: 'vps',
		discovered,
		tenant: 'acme',
		node: 'node-a',
		capacity: answer,
		currentSites: 0,
		...(maxSites === undefined ? {} : { maxSites })
	});
}

describe('buildPlan', () => {
	it('plans every site found rather than one the operator named', () => {
		const built = plan([site('a.example.edu'), site('b.example.edu')]);
		expect(built.sites.map((s) => s.site.host)).toEqual(['a.example.edu', 'b.example.edu']);
	});

	it('lists what will NOT carry, before anything moves', () => {
		const built = plan([site('a.example.edu')]);
		expect(built.notCarried.join(' ')).toContain('PHP extensions');
		expect(built.notCarried.join(' ')).toContain('TLS certificates');
	});

	it('names a reason for every item, carried or not', () => {
		for (const item of CARRY_TABLE) expect(item.reason.length).toBeGreaterThan(10);
	});

	it('marks a site that does not fit and says why, rather than failing the whole plan', () => {
		const built = plan([site('a.example.edu'), site('b.example.edu')], 1);
		expect(built.sites[0]?.fits).toBe(true);
		expect(built.sites[1]?.fits).toBe(false);
		expect(built.sites[1]?.blockedBy).toContain('configured maximum');
	});

	it('consumes capacity as it plans, so the count is the count after the move', () => {
		const built = plan([site('a'), site('b'), site('c')], 2);
		expect(built.sites.filter((s) => s.fits)).toHaveLength(2);
	});

	it('carries the destination s binding term, so a refusal is explicable', () => {
		expect(plan([site('a')]).destination.bindingTerm).toBe('site storage on disk');
	});

	it('sums the bytes being moved', () => {
		expect(plan([site('a'), site('b')]).totalBytes).toBe(10 * 1024 * 1024);
	});
});

describe('assertPlanFits', () => {
	it('passes a plan where every site fits', () => {
		expect(() => assertPlanFits(plan([site('a')]))).not.toThrow();
	});

	it('refuses and names the sites that do not', () => {
		expect(() => assertPlanFits(plan([site('a'), site('b')], 1))).toThrow(/b/);
	});
});

describe('MigrationRun', () => {
	function harness(discovered: DiscoveredSite[], maxSites?: number) {
		const files = memoryFiles();
		const ctx = { ...defaultContext(), files, io: memoryIo(), env: {}, now: () => 1000 };
		const built = plan(discovered, maxSites);
		return { ctx, files, built, run: new MigrationRun(ctx, '/checkpoint.json', built) };
	}

	const hooks = (replays: string[] = []): MigrationHooks => ({
		exportSite: async () => ({ chunks: 3, done: true }),
		provisionSite: async () => {},
		replayChunk: async (site, chunk) => void replays.push(`${site.site.host}:${chunk}`)
	});

	it('walks every site to done', async () => {
		const { run, built } = harness([site('a'), site('b')]);
		const progress = await run.run(built, hooks());
		expect(progress.every((p) => p.stage === 'done')).toBe(true);
		expect(run.done).toBe(true);
	});

	it('replays every chunk', async () => {
		const replays: string[] = [];
		const { run, built } = harness([site('a')]);
		await run.run(built, hooks(replays));
		expect(replays).toEqual(['a:0', 'a:1', 'a:2']);
	});

	it('resumes at the site boundary, so a failed tenth does not re-move the first nine', async () => {
		const { ctx, built } = harness([site('a'), site('b')]);
		const first = new MigrationRun(ctx, '/checkpoint.json', built);
		await first.run(built, {
			...hooks(),
			provisionSite: async (site) => {
				if (site.site.host === 'b') throw new Error('disk full');
			}
		});
		const replays: string[] = [];
		const second = new MigrationRun(ctx, '/checkpoint.json', built);
		await second.run(built, hooks(replays));
		expect(replays.every((entry) => entry.startsWith('b:'))).toBe(true);
	});

	it('records the failure rather than losing it', async () => {
		const { run, built } = harness([site('a')]);
		await run.run(built, {
			...hooks(),
			exportSite: async () => Promise.reject(new Error('ssh refused'))
		});
		expect(run.failed[0]?.error).toContain('ssh refused');
		expect(run.done).toBe(false);
	});

	it('marks a site that does not fit as failed rather than attempting it', async () => {
		const attempted: string[] = [];
		const { run, built } = harness([site('a'), site('b')], 1);
		await run.run(built, {
			...hooks(),
			provisionSite: async (site) => void attempted.push(site.site.host)
		});
		expect(attempted).toEqual(['a']);
		expect(run.failed.map((f) => f.host)).toEqual(['b']);
	});

	it('writes a checkpoint a resumed session can read', async () => {
		const { run, built, files } = harness([site('a')]);
		await run.run(built, hooks());
		expect(JSON.parse(files.readText('/checkpoint.json')).sites[0].stage).toBe('done');
	});
});

describe('refuseDirectSeed', () => {
	it('refuses, and records why rather than leaving it to be re-proposed', () => {
		expect(() => refuseDirectSeed()).toThrow(/runs unmodified/);
	});
});
