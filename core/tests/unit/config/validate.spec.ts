import { describe, expect, it } from 'vitest';
import { LIMIT_FLOORS, RESIDENT_SITE_BYTES } from '../../../src/config/defaults';
import { parseSize, validate } from '../../../src/config/validate';

const base = {
	version: 1,
	mode: 'solo',
	tenants: [{ name: 'acme', sites: [{ host: 'a.example.edu', bundle: './p.tar.gz' }] }]
};

const pathsOf = (raw: unknown, testLane = false): string[] =>
	validate(raw, { testLane }).problems.map((p) => p.path);

describe('parseSize', () => {
	it('takes a plain byte count', () => {
		const problems: never[] = [];
		expect(parseSize(4096, 'x', problems)).toBe(4096);
	});

	it('takes binary and decimal suffixes, which are not the same number', () => {
		const problems: never[] = [];
		expect(parseSize('128Mi', 'x', problems)).toBe(128 * 1024 * 1024);
		expect(parseSize('128M', 'x', problems)).toBe(128 * 1000 * 1000);
		expect(parseSize('4Gi', 'x', problems)).toBe(4 * 1024 ** 3);
	});

	it('reports the path when it is not a size', () => {
		const problems: { path: string; message: string }[] = [];
		expect(parseSize('big', 'front.maxBodyBytes', problems)).toBe(null);
		expect(problems[0]?.path).toBe('front.maxBodyBytes');
	});
});

describe('validate', () => {
	it('accepts a minimal document', () => {
		expect(validate(base).ok).toBe(true);
	});

	it('refuses anything that is not a mapping', () => {
		expect(validate([]).ok).toBe(false);
		expect(validate('x').ok).toBe(false);
	});

	it('reports the path of a bad mode', () => {
		expect(pathsOf({ ...base, mode: 'yolo' })).toContain('mode');
	});

	it('refuses two sites claiming one hostname, because a host IS site identity', () => {
		const problems = pathsOf({
			...base,
			tenants: [
				{ name: 'a', sites: [{ host: 'x.edu', bundle: 'b' }] },
				{ name: 'b', sites: [{ host: 'x.edu', bundle: 'b' }] }
			]
		});
		expect(problems).toContain('tenants[1].sites[0].host');
	});

	it('refuses a duplicate tenant name', () => {
		expect(
			pathsOf({
				...base,
				tenants: [
					{ name: 'a', sites: [] },
					{ name: 'a', sites: [] }
				]
			})
		).toContain('tenants[1].name');
	});

	it('refuses more sites than maxSites', () => {
		expect(
			pathsOf({
				...base,
				tenants: [
					{
						name: 'a',
						limits: { maxSites: 1 },
						sites: [
							{ host: 'x.edu', bundle: 'b' },
							{ host: 'y.edu', bundle: 'b' }
						]
					}
				]
			})
		).toContain('tenants[0].sites');
	});

	it('refuses an unknown capability rather than ignoring it', () => {
		expect(
			pathsOf({ ...base, tenants: [{ name: 'a', sites: [], capabilities: { wat: true } }] })
		).toContain('tenants[0].capabilities.wat');
	});
});

describe('limits are floors, never ceilings', () => {
	for (const [key, floor] of Object.entries(LIMIT_FLOORS)) {
		it(`refuses ${key} below ${floor}`, () => {
			const raw = { ...base, runtime: { limits: { [key]: floor - 1 } } };
			const problems = validate(raw).problems;
			expect(problems.map((p) => p.path)).toContain(`runtime.limits.${key}`);
			// the refusal names the floor, so it is actionable rather than blunt
			expect(problems.find((p) => p.path === `runtime.limits.${key}`)?.message).toContain(
				String(floor)
			);
		});

		it(`accepts ${key} above the floor`, () => {
			expect(validate({ ...base, runtime: { limits: { [key]: floor * 2 } } }).ok).toBe(true);
		});
	}
});

describe('the null cache driver', () => {
	const raw = { ...base, drivers: { cache: { driver: 'null' } } };

	// it reads as a tuning choice and is a 5x throughput cut: every request reaches the object
	it('is refused outside the test lane', () => {
		expect(pathsOf(raw)).toContain('drivers.cache.driver');
	});

	it('is allowed inside it', () => {
		expect(validate(raw, { testLane: true }).ok).toBe(true);
	});
});

describe('residency pin is refused at config time', () => {
	const sites = [
		{ host: 'a.edu', bundle: 'b' },
		{ host: 'b.edu', bundle: 'b' }
	];

	it('refuses when the worst case exceeds the tenant memory limit', () => {
		const tooSmall = Math.floor(RESIDENT_SITE_BYTES);
		const problems = validate({
			...base,
			runtime: { residency: 'pin' },
			tenants: [{ name: 'a', sites, limits: { memory: tooSmall } }]
		}).problems;
		const hit = problems.find((p) => p.path === 'tenants[0].limits.memory');
		expect(hit).toBeDefined();
		// both numbers named, so the operator can size it rather than guess
		expect(hit?.message).toContain(String(tooSmall));
		expect(hit?.message).toContain('2 sites');
	});

	it('accepts when the budget fits', () => {
		const enough = Math.ceil(RESIDENT_SITE_BYTES * 2) + 1;
		expect(
			validate({
				...base,
				runtime: { residency: 'pin' },
				tenants: [{ name: 'a', sites, limits: { memory: enough } }]
			}).ok
		).toBe(true);
	});

	it('does not apply under evict, where residency is a working set', () => {
		expect(
			validate({
				...base,
				runtime: { residency: 'evict' },
				tenants: [{ name: 'a', sites, limits: { memory: 1024 } }]
			}).ok
		).toBe(true);
	});
});

describe('cluster', () => {
	it('requires a control address on a child, because a child dials out', () => {
		expect(pathsOf({ ...base, cluster: { role: 'child', node: { id: 'node-b' } } })).toContain(
			'cluster.control.address'
		);
	});

	it('does not require one on the control node', () => {
		expect(validate({ ...base, cluster: { role: 'control', node: { id: 'node-a' } } }).ok).toBe(
			true
		);
	});
});

describe('host identity is case insensitive, as DNS is', () => {
	function withSites(tenants: { name: string; sites: Record<string, unknown>[] }[]) {
		return validate({ ...base, tenants });
	}

	it('refuses two sites whose hosts differ only in case', () => {
		const result = withSites([
			{
				name: 'acme',
				sites: [
					{ host: 'www.example.edu', bundle: './p', probe: 'drupflare' },
					{ host: 'WWW.Example.EDU', bundle: './p', probe: 'drupflare' }
				]
			}
		]);
		expect(result.ok).toBe(false);
		expect(result.problems.map((p) => p.message).join(' ')).toContain('already served by');
	});

	it('refuses the collision ACROSS tenants, which is the case that leaks', () => {
		const result = withSites([
			{
				name: 'acme',
				sites: [{ host: 'www.example.edu', bundle: './p', probe: 'drupflare' }]
			},
			{
				name: 'labs',
				sites: [{ host: 'WWW.EXAMPLE.EDU', bundle: './p', probe: 'drupflare' }]
			}
		]);
		expect(result.ok).toBe(false);
	});

	it('refuses an alias that collides with another site s host', () => {
		const result = withSites([
			{ name: 'acme', sites: [{ host: 'a.example.edu', bundle: './p', probe: 'drupflare' }] },
			{
				name: 'labs',
				sites: [
					{
						host: 'b.example.edu',
						bundle: './p',
						probe: 'drupflare',
						aliases: ['A.Example.edu']
					}
				]
			}
		]);
		expect(result.ok).toBe(false);
	});

	it('refuses a canonical name the site does not serve', () => {
		const result = withSites([
			{
				name: 'acme',
				sites: [
					{
						host: 'a.example.edu',
						bundle: './p',
						probe: 'drupflare',
						canonical: 'elsewhere.example'
					}
				]
			}
		]);
		expect(result.ok).toBe(false);
		expect(result.problems.map((p) => p.message).join(' ')).toContain(
			'redirect to a name this site does not serve'
		);
	});

	it('accepts a canonical name that is an alias', () => {
		const result = withSites([
			{
				name: 'acme',
				sites: [
					{
						host: 'www.example.edu',
						bundle: './p',
						probe: 'drupflare',
						aliases: ['example.edu'],
						canonical: 'example.edu'
					}
				]
			}
		]);
		expect(result.ok).toBe(true);
	});
});

describe('the worker block, which is what makes a bundle other than drupflare expressible', () => {
	const withWorker = (worker: unknown) =>
		validate({
			...base,
			tenants: [
				{ name: 'acme', sites: [{ host: 'a.example.edu', bundle: './p.tar.gz', worker }] }
			]
		});

	it('accepts a site that declares none, which is every site written before it existed', () => {
		expect(validate(base).ok).toBe(true);
	});

	it('accepts a worker that declares it has no object', () => {
		const result = withWorker({ durableObjectClass: null, durableObject: undefined });
		expect(result.ok).toBe(true);
	});

	it('refuses a class with no binding, which nothing in the worker could reach', () => {
		const result = withWorker({ durableObjectClass: 'Counter', durableObject: undefined });
		expect(result.ok).toBe(false);
		expect(result.problems[0]?.message).toMatch(/no binding/);
	});

	it('refuses a binding with no class, which workerd refuses at startup', () => {
		const result = withWorker({ durableObjectClass: null, durableObject: 'COUNTER' });
		expect(result.ok).toBe(false);
		expect(result.problems[0]?.message).toMatch(/no class/);
	});

	it('refuses a block that is not a mapping', () => {
		expect(withWorker(['index.js']).ok).toBe(false);
		expect(withWorker('index.js').ok).toBe(false);
	});

	it('reports the path of a slot that is not a list of names', () => {
		const result = withWorker({ kv: 'SESSIONS' });
		expect(result.problems.map((p) => p.path)).toContain('tenants[0].sites[0].worker.kv');
	});

	it('reports the path of an entrypoint that is not a string', () => {
		const result = withWorker({ main: 7 });
		expect(result.problems.map((p) => p.path)).toContain('tenants[0].sites[0].worker.main');
	});

	it('accepts a fully stated arbitrary worker', () => {
		const result = withWorker({
			main: 'server.js',
			durableObjectClass: null,
			durableObject: undefined,
			assets: undefined,
			kv: ['SESSIONS'],
			r2: [],
			queues: ['JOBS'],
			compatibilityFlags: ['nodejs_compat']
		});
		expect(result.ok).toBe(true);
	});
});

/**
 * A binding is refused unless its primitive exists.
 *
 * None of these is on a server image. ImageMagick is absent from Debian, Ubuntu, RHEL and Alpine
 * until somebody installs it; no image ships a headless browser; an inference endpoint, a vector
 * index and a mail server are each something an operator runs on purpose. bastion installs none of
 * them, so the configuration is refused rather than accepted and failed on the first request.
 */
describe('a binding whose primitive nobody installed', () => {
	const withWorker = (worker: unknown, drivers?: Record<string, unknown>) =>
		validate({
			...base,
			...(drivers === undefined ? {} : { drivers }),
			tenants: [
				{ name: 'acme', sites: [{ host: 'a.example.edu', bundle: './p.tar.gz', worker }] }
			]
		});

	it('refuses images with no drivers.images, and names the install', () => {
		const result = withWorker({ durableObjectClass: null, images: ['IMAGES'] });
		expect(result.ok).toBe(false);
		expect(result.problems[0]?.message).toMatch(/install imagemagick/);
	});

	it('refuses browser with no drivers.browser', () => {
		const result = withWorker({ durableObjectClass: null, browser: ['BROWSER'] });
		expect(result.ok).toBe(false);
		expect(result.problems[0]?.message).toMatch(/install chromium/);
	});

	it('refuses ai, vectorize and email the same way', () => {
		for (const [slot, binding] of [
			['ai', 'AI'],
			['vectorize', 'INDEX'],
			['email', 'SEB']
		] as const) {
			const result = withWorker({ durableObjectClass: null, [slot]: [binding] });
			expect(result.ok).toBe(false);
			expect(result.problems[0]?.path).toBe(`tenants[0].sites[0].worker.${slot}`);
		}
	});

	it('names every binding in the refusal, not just the first', () => {
		const result = withWorker({ durableObjectClass: null, images: ['A', 'B'] });
		expect(result.problems[0]?.message).toMatch(/A, B/);
	});

	it('accepts it once the operator has configured the driver', () => {
		const result = withWorker(
			{ durableObjectClass: null, images: ['IMAGES'] },
			{
				images: { driver: 'magick' }
			}
		);
		expect(result.ok).toBe(true);
	});

	it('leaves d1 alone, because sqlite is compiled in and needs no operator action', () => {
		expect(withWorker({ durableObjectClass: null, d1: ['DB'] }).ok).toBe(true);
	});

	it('leaves analytics alone, because the ring lives in bastion own process', () => {
		expect(withWorker({ durableObjectClass: null, analytics: ['AE'] }).ok).toBe(true);
	});

	it('says nothing about a slot the site does not bind', () => {
		expect(withWorker({ durableObjectClass: null, kv: ['SESSIONS'] }).ok).toBe(true);
	});
});
