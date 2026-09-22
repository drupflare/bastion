import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseJsonc, planFromManifest, refusals } from '../../../src/deploy/template';

/**
 * Four real Worker manifests, copied from the repositories that ship them.
 *
 * These are the second and third tier bastion is meant to host, and none of them was written with
 * bastion in mind, which is the point: a template reader tested only against a manifest written
 * for the reader proves nothing. Every expectation below was read out of the fixture rather than
 * chosen, so a manifest that changes shape fails here instead of at install time.
 */
const load = (name: string) =>
	planFromManifest(
		parseJsonc(
			readFileSync(new URL(`../../fixtures/templates/${name}.jsonc`, import.meta.url), 'utf8')
		)
	);

const bound = (plan: ReturnType<typeof load>, type: string) =>
	plan.findings.filter((f) => f.type === type && f.carried).map((f) => f.name);

describe('parseJsonc', () => {
	it('takes a line comment, which every one of these manifests carries somewhere', () => {
		expect(parseJsonc('{ // a note\n "a": 1 }')).toEqual({ a: 1 });
	});

	it('takes a block comment', () => {
		expect(parseJsonc('{ /* a\nnote */ "a": 1 }')).toEqual({ a: 1 });
	});

	it('takes a trailing comma', () => {
		expect(parseJsonc('{ "a": [1, 2,], }')).toEqual({ a: [1, 2] });
	});

	it('leaves a slash inside a string alone, since values carry urls', () => {
		expect(parseJsonc('{ "a": "https://x/y" }')).toEqual({ a: 'https://x/y' });
	});

	it('leaves an escaped quote alone', () => {
		expect(parseJsonc('{ "a": "say \\" //not a comment" }')).toEqual({
			a: 'say " //not a comment'
		});
	});

	it('refuses a manifest that is not jsonc rather than guessing', () => {
		expect(() => parseJsonc('{ nope }')).toThrow(/not valid jsonc/);
	});

	it('refuses a manifest that is not an object', () => {
		expect(() => planFromManifest([1, 2])).toThrow(/not an object/);
	});
});

describe('drupflare/worker', () => {
	const plan = load('drupflare');

	it('carries the durable object the bundle exports', () => {
		expect(plan.worker.durableObject).toBe('SITE');
		expect(plan.worker.durableObjectClass).toBe('SitePhpDurableObject');
	});

	it('carries both kv namespaces under the names the bundle reads', () => {
		expect(plan.worker.kv).toEqual(['CONFIG_KV', 'PAGE_KV']);
	});

	it('carries the assets binding', () => {
		expect(plan.worker.assets).toBe('ASSETS');
	});

	it('takes the entrypoint and compatibility settings from the manifest', () => {
		expect(plan.worker.main).toBe('src/site.ts');
		expect(plan.worker.compatibilityDate).toBe('2026-08-01');
		expect(plan.worker.compatibilityFlags).toEqual(['nodejs_compat']);
	});

	it('carries every var the bundle reads', () => {
		expect(bound(plan, 'vars')).toContain('PLAN');
		expect(bound(plan, 'vars')).toContain('LAZY_MOUNT');
	});

	it('carries the fleet database through the wrapped shim', () => {
		expect(plan.worker.d1).toEqual(['FLEET_DB']);
	});

	it('carries version metadata, which bastion already knows from its own version store', () => {
		expect(plan.worker.versionMetadata).toBe('CF_VERSION_METADATA');
	});

	it('carries the fleet database as hyperdrive would, not as a shim', () => {
		expect(plan.worker.d1).toEqual(['FLEET_DB']);
	});

	it('reports the cron the manifest declares rather than dropping it', () => {
		expect(plan.crons).toEqual(['*/5 * * * *']);
	});

	it('is the shape the generator already had, so the default did not come from nowhere', () => {
		expect(plan.worker.durableObjectClass).toBe('SitePhpDurableObject');
		expect(plan.worker.assets).toBe('ASSETS');
	});
});

describe('@earth-app/smoke', () => {
	const plan = load('smoke');

	it('has no durable object, so no namespace is emitted for it', () => {
		expect(plan.worker.durableObjectClass).toBeNull();
		expect(plan.worker.durableObject).toBeUndefined();
	});

	it('carries both kv namespaces', () => {
		expect(plan.worker.kv).toEqual(['KV', 'CACHE']);
	});

	it('carries the blob bucket', () => {
		expect(plan.worker.r2).toEqual(['BLOB']);
	});

	it('carries all three databases, each as its own wrapped binding', () => {
		expect(plan.worker.d1).toEqual(['DB', 'DB_SECONDARY', 'DB_TERTIARY']);
	});

	it('reports its three crons', () => {
		expect(plan.crons).toHaveLength(3);
	});

	it('takes the compatibility date out of the manifest', () => {
		expect(plan.worker.compatibilityDate).toBe('2026-05-18');
	});

	it('serves no assets, so no assets service is attached', () => {
		expect(plan.worker.assets).toBeUndefined();
	});
});

describe('MyLoRA', () => {
	const plan = load('mylora');

	it('carries the durable object under the name the manifest gives it', () => {
		expect(plan.worker.durableObject).toBe('$DurableObject');
		expect(plan.worker.durableObjectClass).toBe('$DurableObject');
	});

	it('carries kv and r2', () => {
		expect(plan.worker.kv).toEqual(['KV', 'CACHE']);
		expect(plan.worker.r2).toEqual(['BLOB']);
	});

	it('carries the ai binding, which a local inference endpoint serves', () => {
		expect(plan.worker.ai).toEqual(['AI']);
	});

	it('carries its database', () => {
		expect(plan.worker.d1).toEqual(['DB']);
	});

	it('reports the every-minute cron rather than silently not running it', () => {
		expect(plan.crons).toEqual(['* * * * *']);
	});
});

describe('nuxtpress', () => {
	const plan = load('nuxtpress');

	it('is a plain worker: no object, no assets, no bucket', () => {
		expect(plan.worker.durableObjectClass).toBeNull();
		expect(plan.worker.assets).toBeUndefined();
		expect(plan.worker.r2).toEqual([]);
	});

	it('carries the two kv namespaces it does declare', () => {
		expect(plan.worker.kv).toEqual(['KV', 'CACHE']);
	});

	it('carries its database', () => {
		expect(plan.worker.d1).toEqual(['DB']);
	});

	it('declares no crons', () => {
		expect(plan.crons).toEqual([]);
	});
});

describe('what the reader refuses across every template', () => {
	it('names a binding rather than a block, so a message is actionable', () => {
		for (const name of ['drupflare', 'smoke', 'mylora', 'nuxtpress']) {
			for (const finding of refusals(load(name))) {
				expect(finding.name).not.toBe('');
				expect(finding.reason).not.toBe('');
			}
		}
	});

	it('refuses a durable object class that lives in another worker', () => {
		const plan = planFromManifest({
			durable_objects: {
				bindings: [{ name: 'OTHER', class_name: 'Thing', script_name: 'elsewhere' }]
			}
		});
		expect(refusals(plan)[0]?.reason).toMatch(/another Worker/);
		expect(plan.worker.durableObjectClass).toBeNull();
	});

	it('refuses a second durable object class rather than binding a namespace that is absent', () => {
		const plan = planFromManifest({
			durable_objects: {
				bindings: [
					{ name: 'A', class_name: 'First' },
					{ name: 'B', class_name: 'Second' }
				]
			}
		});
		expect(plan.worker.durableObject).toBe('A');
		expect(refusals(plan).map((f) => f.name)).toEqual(['B']);
	});

	it('carries a queue producer', () => {
		const plan = planFromManifest({ queues: { producers: [{ binding: 'JOBS' }] } });
		expect(plan.worker.queues).toEqual(['JOBS']);
	});

	it('takes the worker name where the manifest states one', () => {
		expect(load('drupflare').name).toBe('drupflare');
		expect(load('smoke').name).toBeNull();
	});
});
