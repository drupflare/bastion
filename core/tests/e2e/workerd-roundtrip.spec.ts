import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ASSET_PROFILES, assetResolver } from '../../src/adapters/assets';
import { memoryCacheStore } from '../../src/adapters/cache';
import { renderConfig } from '../../src/capnp/generate';
import { modulesFrom, planSite } from '../../src/capnp/plan';
import { defaultContext } from '../../src/context';
import { memoryKv } from '../../src/drivers/memory-kv';
import { nodeFiles } from '../../src/host/files';
import { bindAdapters } from './support/adapters';
import { gate } from './support/gate';
import { overSocket, type SocketResponse } from './support/http';

/**
 * The capnp bastion generates, booted by a real workerd against the real release payload.
 *
 * Nothing hermetic stands in for this. The gate lane proves bastion renders the configuration it
 * means to; only a boot proves workerd accepts it, and only the release payload proves the claim
 * that the same site binary runs unmodified.
 */
const workerd = process.env.WORKERD_BINARY ?? 'workerd';
const payload = process.env.PAYLOAD_DIR ?? '';

/**
 * Skips only when nobody asked for this lane; refuses when they did and it cannot run.
 *
 * It used to skip on a missing artifact even under `REQUIRE_PAYLOAD=1`, which is how the one lane
 * that proves the generated configuration boots printed a reason and went green for the whole of
 * development. A skip reads as a pass in every summary that matters.
 */
const reason = gate('REQUIRE_PAYLOAD', [
	{ what: 'PAYLOAD_DIR is not set', present: payload !== '' },
	{
		what: `${payload}/site.js is absent`,
		present: payload !== '' && existsSync(join(payload, 'site.js'))
	}
]);
const children: { kill(signal?: NodeJS.Signals): void }[] = [];
let bound: { stop(): void; readonly failures: string[] } | null = null;

afterAll(() => {
	for (const child of children) child.kill('SIGTERM');
	bound?.stop();
});

describe.skipIf(reason !== null)(`workerd round trip (${reason ?? 'enabled'})`, () => {
	const root = mkdtempSync(join(tmpdir(), 'bastion-e2e-'));
	const listen = join(root, 'http.sock');

	/**
	 * The module list comes from the runtime's own function, not from a list written here.
	 *
	 * This lane used to build one by hand with a `path` field `ModuleSpec` does not carry, so the
	 * generator fell back to `embed = "site.js"`, Cap'n Proto resolved it against the directory
	 * holding the config, and workerd answered `Couldn't read file for embed: site.js`. A rig that
	 * assembles its own input tests the rig.
	 *
	 * Built inside the test rather than in the describe body, because vitest evaluates that body
	 * even for a suite it is about to skip, and reading a bundle that is not there crashes the file
	 * for every other lane in the run.
	 */
	const plan = () =>
		planSite({
			tenant: { name: 'acme', sites: [] },
			site: { host: '127.0.0.1', bundle: payload, probe: 'drupflare' },
			paths: {
				bundle: payload,
				storage: join(root, 'storage'),
				assets: join(payload, 'assets'),
				adapterDir: root,
				listenSocket: listen
			},
			modules: modulesFrom(defaultContext(), payload, 'site.js', root),
			compatibilityDate: '2026-08-01',
			compatibilityFlags: ['nodejs_compat'],
			uniqueKey: 'bastion-e2e-probe',
			durableObjectClass: 'SitePhpDurableObject',
			residency: 'evict',
			bindings: {
				durableObject: 'SITE',
				assets: 'ASSETS',
				kv: ['CONFIG_KV', 'PAGE_KV'],
				r2: [],
				queues: []
			},
			vars: { PLAN: 'free', LAZY_MOUNT: '1' }
		});

	it('generates a configuration workerd parses and boots', async () => {
		// workerd refuses a `disk` service whose directory is absent and creates none of them; the
		// runtime does this in `startTenant`, so a rig that writes its own config must do it too
		mkdirSync(join(root, 'storage'), { recursive: true });

		// and the payload reads KV and the Cache API before it renders anything, so a run with no
		// adapters answers 500 on every route with `connect(): No such file or directory`
		bound = await bindAdapters(
			{
				cache: memoryCacheStore(),
				kv: memoryKv(),
				r2: memoryKv(),
				queues: memoryKv(),
				assets: assetResolver(
					nodeFiles(),
					join(payload, 'assets'),
					ASSET_PROFILES.drupflare
				),
				tenant: 'acme'
			},
			root
		);

		const path = join(root, 'config.capnp');
		writeFileSync(path, renderConfig(plan()));
		expect(readFileSync(path, 'utf8')).toContain('cacheApiOutbound');

		const child = spawn(workerd, ['serve', path], { stdio: ['ignore', 'pipe', 'pipe'] });
		children.push(child);
		let stderr = '';
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		// a spawn that never started reads exactly like one that started and hung
		let unstarted: string | null = null;
		child.on('error', (error: NodeJS.ErrnoException) => {
			unstarted =
				error.code === 'ENOENT'
					? `${workerd} is not on this PATH; install it or point WORKERD_BINARY at one`
					: `${workerd} could not start: ${error.message}`;
		});

		const deadline = Date.now() + 60_000;
		let answered = false;
		while (Date.now() < deadline && !answered) {
			if (unstarted !== null) throw new Error(unstarted);
			try {
				answered = (await overSocket(listen, '/')).status > 0;
			} catch {
				await new Promise((r) => setTimeout(r, 500));
			}
		}
		expect(answered, `workerd never answered. stderr:\n${stderr}`).toBe(true);
	});

	/**
	 * A fresh site provisions itself before it serves anything.
	 *
	 * The first request starts a 75-chunk pack replay on the alarm chain and every request until it
	 * finishes answers 503 `migrating` with a `retry-after` and an `x-cfw-migrate: 40/75` counter.
	 * That is the payload working, so the lane honours the retry rather than reading the 503 as a
	 * failure -- and the counter is what tells a stall from a slow replay.
	 */
	async function settled(path: string): Promise<SocketResponse> {
		const deadline = Date.now() + 300_000;
		let last = await overSocket(listen, path);
		while (Date.now() < deadline && last.status === 503) {
			await new Promise((r) => setTimeout(r, 500));
			last = await overSocket(listen, path);
		}
		return last;
	}

	it('replays its pack and stops answering 503', async () => {
		const response = await settled('/');
		expect(
			response.status,
			`still migrating: ${String(response.headers['x-cfw-migrate'])}`
		).not.toBe(503);
		expect(bound?.failures ?? []).toEqual([]);
	});

	it('renders a path outside prefill.json, which is what proves a real boot', async () => {
		const response = await settled('/node/1');
		expect(response.headers['x-cfw-php-booted']).toBe('1');
	});

	it('never serves the site database, which leaked publicly in the smoke lane', async () => {
		expect((await settled('/drupal/site.sqlite')).status).toBe(404);
	});
});
