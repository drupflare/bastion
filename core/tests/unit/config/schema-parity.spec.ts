import Ajv from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { WRAPPED_SLOTS } from '../../../src/capnp/plan';
import schema from '../../../src/config/schema.json' with { type: 'json' };
import { validate } from '../../../src/config/validate';

/**
 * `config/schema.json` is what an editor reads and `config/validate.ts` is what the runtime reads.
 * Two implementations of one contract drift silently, so this runs both over one corpus and fails
 * when they disagree about whether a document is acceptable.
 *
 * ajv is a TEST-LANE dependency only; the runtime carries no schema library.
 */
const ajv = new Ajv({ allErrors: true, strict: false });
const bySchema = ajv.compile(schema);

const site = { host: 'a.example.edu', bundle: './p.tar.gz' };
const tenant = { name: 'acme', sites: [site] };

const accept: [string, unknown][] = [
	['a minimal document', { version: 1, mode: 'solo', tenants: [tenant] }],
	['no tenants at all', { version: 1, tenants: [] }],
	['a raised isolate memory', { version: 1, runtime: { limits: { isolateMemory: '256Mi' } } }],
	['a control node', { version: 1, cluster: { role: 'control', node: { id: 'node-a' } } }],
	[
		'a child with a control address',
		{
			version: 1,
			cluster: { role: 'child', control: { address: '10.0.0.1:8788' }, node: { id: 'b' } }
		}
	],
	['every log level', { version: 1, logs: { level: 'debug' }, audit: { level: 'critical' } }],
	[
		'a tenant capability block',
		{ version: 1, tenants: [{ ...tenant, capabilities: { codegen: true } }] }
	],
	// derived rather than listed: the schema carried six driver keys while the validator refused a
	// browser binding for want of `drivers.browser`, so an editor rejected a document the runtime
	// required. A new wrapped slot now fails here until the schema carries its key too
	[
		'a driver for every wrapped slot that names one',
		{
			version: 1,
			drivers: Object.fromEntries(
				WRAPPED_SLOTS.filter((slot) => slot.driver !== null).map((slot) => [
					slot.driver,
					{ driver: 'whatever-the-operator-runs' }
				])
			)
		}
	]
];

const reject: [string, unknown][] = [
	['a bad mode', { version: 1, mode: 'yolo' }],
	['a bad version', { version: 2 }],
	['an unknown log level', { version: 1, logs: { level: 'chatty' } }],
	[
		'an unknown capability',
		{ version: 1, tenants: [{ ...tenant, capabilities: { wat: true } }] }
	],
	['a driver with no name', { version: 1, drivers: { kv: {} } }],
	['a site with no bundle', { version: 1, tenants: [{ name: 'a', sites: [{ host: 'x.edu' }] }] }],
	['a tenant with no name', { version: 1, tenants: [{ sites: [] }] }],
	['a bad node id', { version: 1, cluster: { role: 'control', node: { id: 'Node A' } } }],
	[
		'an isolate memory below the floor',
		{ version: 1, runtime: { limits: { isolateMemory: 1024 } } }
	]
];

/**
 * One asymmetry, named rather than papered over.
 *
 * A size may be written `128Mi`, and JSON Schema cannot compare a string against a byte floor. So
 * the schema carries the floor on the INTEGER form only, and a below-floor value written as a
 * string is caught by the runtime validator alone. The editor warns where it can; the runtime
 * refuses in every case.
 */
const runtimeOnly: [string, unknown][] = [
	[
		'a below-floor size written as a string',
		{ version: 1, runtime: { limits: { isolateMemory: '1Ki' } } }
	]
];

describe('schema.json and validate.ts agree', () => {
	for (const [label, doc] of accept) {
		it(`both accept ${label}`, () => {
			expect(bySchema(doc), `schema rejected: ${ajv.errorsText(bySchema.errors)}`).toBe(true);
			const result = validate(doc);
			expect(result.ok, `validator rejected: ${JSON.stringify(result.problems)}`).toBe(true);
		});
	}

	for (const [label, doc] of reject) {
		it(`both reject ${label}`, () => {
			const schemaOk = bySchema(doc);
			const runtimeOk = validate(doc).ok;
			expect(
				schemaOk === false || runtimeOk === false,
				`schema=${schemaOk} runtime=${runtimeOk}`
			).toBe(true);
			// and neither may accept it silently
			expect(schemaOk).toBe(false);
			expect(runtimeOk).toBe(false);
		});
	}
});

describe('what only the runtime validator can catch', () => {
	for (const [label, doc] of runtimeOnly) {
		it(`the validator rejects ${label} and the schema cannot`, () => {
			expect(validate(doc).ok).toBe(false);
			expect(bySchema(doc)).toBe(true);
		});
	}
});

describe('the schema itself', () => {
	it('compiles', () => {
		expect(typeof bySchema).toBe('function');
	});

	it('pins the floors so an editor warns before the runtime refuses', () => {
		const at = (...keys: string[]): unknown =>
			keys.reduce<unknown>(
				(node, key) =>
					node !== null && typeof node === 'object'
						? (node as Record<string, unknown>)[key]
						: undefined,
				schema
			);
		const floorOf = (key: string): unknown =>
			at('properties', 'runtime', 'properties', 'limits', 'properties', key, 'minimum');
		expect(floorOf('subrequests')).toBe(50);
		expect(floorOf('startupMs')).toBe(1000);
		expect(floorOf('alarmMs')).toBe(900000);
	});
});
