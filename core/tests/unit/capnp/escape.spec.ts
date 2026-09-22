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
		expect(() => ident('main-worker')).toThrow(/not a capnp identifier/);
		expect(() => ident('1main')).toThrow(/not a capnp identifier/);
	});

	it('derives a safe service name from arbitrary text', () => {
		expect(serviceName('w', 'www.example.edu')).toBe('w_www_example_edu');
		expect(serviceName('w', '!!!')).toBe('w_x');
	});
});
