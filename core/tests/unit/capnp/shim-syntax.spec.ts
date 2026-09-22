import { describe, expect, it } from 'vitest';
import { WRAPPED_SLOTS } from '../../../src/capnp/plan';
import * as shims from '../../../src/capnp/shims';

/**
 * Every shim is javascript workerd can parse.
 *
 * These live as template literals in TypeScript, which is the one place a syntax error survives
 * every other check: `tsc` sees a string, prettier formats around it, and the capnp generator
 * embeds it without looking. A backtick inside a comment in the D1 shim closed the literal early
 * and truncated the module; the gate lane was green and the failure only appeared when workerd
 * tried to instantiate it.
 *
 * `new Function` compiles without running, so a parse error fails here and nothing in these
 * modules executes.
 */
const SOURCES: [string, string][] = [
	['d1', shims.D1_SHIM],
	['ai', shims.AI_SHIM],
	['vectorize', shims.VECTORIZE_SHIM],
	['images', shims.IMAGES_SHIM],
	['browser', shims.BROWSER_SHIM],
	['email', shims.EMAIL_SHIM],
	['analytics', shims.ANALYTICS_SHIM]
];

describe('every shim parses', () => {
	it.each(SOURCES)('%s is syntactically valid javascript', (_name, source) => {
		// the module form, since each one uses `export default`
		expect(() => new Function(source.replace(/^export default /m, 'return '))).not.toThrow();
	});

	it.each(SOURCES)('%s carries a default export for the entrypoint to call', (_name, source) => {
		expect(source).toMatch(/export default function \(env\)/);
	});

	it.each(SOURCES)('%s closes every template literal it opens', (_name, source) => {
		// an odd count means one is still open where the TypeScript literal ended
		expect((source.match(/`/g) ?? []).length % 2).toBe(0);
	});

	it.each(SOURCES)('%s reads the fetcher and nothing else off env', (_name, source) => {
		// comments name other bindings while explaining themselves, and a comment reads nothing
		const code = source.replace(/^\s*\/\/.*$/gm, '');
		const reads = [...code.matchAll(/env\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
		expect([...new Set(reads)]).toEqual(['fetcher']);
	});

	it.each(SOURCES)('%s dials bastion and no other host', (_name, source) => {
		for (const url of source.match(/'https?:\/\/[^']+'/g) ?? []) {
			expect(url).toMatch(/^'http:\/\/bastion/);
		}
	});

	it('covers every shim the slot table names, so a new one cannot skip this file', () => {
		const covered = new Set(SOURCES.map(([name]) => name));
		for (const slot of WRAPPED_SLOTS) expect(covered.has(slot.key)).toBe(true);
	});

	it('names a module under the bastion scheme for each slot', () => {
		for (const slot of WRAPPED_SLOTS) expect(slot.moduleName).toMatch(/^bastion:/);
	});
});
