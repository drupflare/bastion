import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderConfig } from '../../src/capnp/generate';
import { planSite } from '../../src/capnp/plan';

/**
 * The capnp bastion generates, booted by a real workerd against the real release payload.
 *
 * Nothing hermetic stands in for this. The gate lane proves bastion renders the configuration it
 * means to; only a boot proves workerd accepts it, and only the release payload proves the claim
 * that the same site binary runs unmodified. Skips rather than fails without the artifact, and
 * says which requirement was missing.
 */
const workerd = process.env.WORKERD_BINARY ?? 'workerd';
const payload = process.env.PAYLOAD_DIR ?? '';
const enabled = process.env.REQUIRE_PAYLOAD === '1';

function missing(): string | null {
	if (!enabled) return 'REQUIRE_PAYLOAD=1 is not set';
	if (payload === '') return 'PAYLOAD_DIR is not set';
	if (!existsSync(join(payload, 'site.js'))) return `${payload}/site.js is absent`;
	return null;
}

const reason = missing();
const children: { kill(signal?: NodeJS.Signals): void }[] = [];

afterAll(() => {
	for (const child of children) child.kill('SIGTERM');
});

describe.skipIf(reason !== null)(`workerd round trip (${reason ?? 'enabled'})`, () => {
	const root = mkdtempSync(join(tmpdir(), 'bastion-e2e-'));
	const port = 18787 + Math.floor(Math.random() * 500);

	const modules = [
		{ name: 'site.js', kind: 'esModule' as const, path: join(payload, 'site.js') }
	];

	const config = planSite({
		tenant: { name: 'acme', sites: [] },
		site: { host: '127.0.0.1', bundle: payload, probe: 'drupflare' },
		paths: {
			bundle: payload,
			storage: join(root, 'storage'),
			assets: join(payload, 'assets'),
			adapterSocket: join(root, 'adapters.sock'),
			listenSocket: `127.0.0.1:${port}`
		},
		modules,
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
		const path = join(root, 'config.capnp');
		writeFileSync(path, renderConfig(config));
		expect(readFileSync(path, 'utf8')).toContain('cacheApiOutbound');

		const child = spawn(workerd, ['serve', path], { stdio: ['ignore', 'pipe', 'pipe'] });
		children.push(child);
		let stderr = '';
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const deadline = Date.now() + 60_000;
		let answered = false;
		while (Date.now() < deadline && !answered) {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/`, {
					headers: { host: '127.0.0.1' }
				});
				answered = response.status > 0;
			} catch {
				await new Promise((r) => setTimeout(r, 500));
			}
		}
		expect(answered, `workerd never answered. stderr:\n${stderr}`).toBe(true);
	});

	it('renders a path outside prefill.json, which is what proves a real boot', async () => {
		const response = await fetch(`http://127.0.0.1:${port}/node/1`, {
			headers: { host: '127.0.0.1' }
		});
		expect(response.headers.get('x-cfw-php-booted')).toBe('1');
	});

	it('never serves the site database, which leaked publicly in the smoke lane', async () => {
		const response = await fetch(`http://127.0.0.1:${port}/drupal/site.sqlite`, {
			headers: { host: '127.0.0.1' }
		});
		expect(response.status).toBe(404);
	});
});
