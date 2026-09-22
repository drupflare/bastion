import { describe, expect, it } from 'vitest';
import { ident, serviceName, text } from '../../../src/capnp/escape';

describe('capnp text literals', () => {
	it('quotes a plain string', () => {
		expect(text('hello')).toBe('"hello"');
	});

	// a tenant name or bundle path carrying a quote would otherwise close the literal and inject
	// configuration into the runtime that serves every other tenant on the box
	it('escapes a quote so a value cannot close the literal', () => {
		expect(text('a", evil = "x')).toBe('"a\\", evil = \\"x"');
	});

	it('escapes a backslash', () => {
		expect(text('a\\b')).toBe('"a\\\\b"');
	});

	it('escapes newlines and tabs rather than emitting them raw', () => {
		expect(text('a\nb\tc\r')).toBe('"a\\nb\\tc\\r"');
	});

	it('hex-escapes a control character, which has no literal form', () => {
		expect(text('a\u0000b')).toBe('"a\\x00b"');
		expect(text('a\u007fb')).toBe('"a\\x7fb"');
	});

	it('leaves non-ascii alone, because capnp text is utf-8', () => {
		expect(text('café')).toBe('"café"');
	});
});

describe('identifiers', () => {
	it('accepts a capnp identifier', () => {
		expect(ident('mainWorker')).toBe('mainWorker');
	});

	it('refuses anything else rather than escaping it', () => {
		expect(() => ident('main-worker')).toThrow(/not a capnp declaration name/);
		expect(() => ident('1main')).toThrow(/not a capnp declaration name/);
	});

	/**
	 * An underscore in a DECLARATION name stops workerd starting.
	 *
	 * `const w_main :Workerd.Worker` makes the parser answer "declaration names should use
	 * camelCase and must not contain underscores" and the process exits before it binds anything.
	 * The generator emitted that form for every configuration until a real workerd was pointed at
	 * one. A service's `name = "..."` is a string literal and keeps its underscores.
	 */
	it('refuses an underscore, which workerd will not parse', () => {
		expect(() => ident('w_main')).toThrow(/not a capnp declaration name/);
	});

	it('derives a camelCase declaration name from arbitrary text', () => {
		expect(serviceName('w', 'www.example.edu')).toBe('wWwwExampleEdu');
		expect(serviceName('w', 'main')).toBe('wMain');
		expect(serviceName('w', '!!!')).toBe('wX');
	});

	it('never produces an underscore, whatever the tenant is called', () => {
		for (const name of ['a_b', 'a-b', 'a.b', 'a b', '__x__', 'ACME', '9lives', 'ünïcødé']) {
			expect(serviceName('w', name)).not.toContain('_');
			expect(() => ident(serviceName('w', name))).not.toThrow();
		}
	});
});
