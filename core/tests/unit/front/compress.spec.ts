import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { chooseEncoding, compress, parseAcceptEncoding } from '../../../src/front/compress';

const policy = { encodings: ['br', 'gzip'], minBytes: 1024 };
const big = 5000;

describe('parseAcceptEncoding', () => {
	it('reads the quality and drops anything offered at zero', () => {
		expect(parseAcceptEncoding('gzip;q=0.5, br;q=1.0, deflate;q=0')).toEqual([
			{ encoding: 'gzip', quality: 0.5 },
			{ encoding: 'br', quality: 1 }
		]);
	});

	it('returns nothing for an absent header', () => {
		expect(parseAcceptEncoding(null)).toEqual([]);
	});
});

describe('chooseEncoding', () => {
	it('prefers the highest quality the policy also offers', () => {
		expect(chooseEncoding('gzip;q=1.0, br;q=0.5', 'text/html', big, policy)).toBe('gzip');
	});

	it('never picks an encoding the policy leaves out, however the client ranks it', () => {
		expect(chooseEncoding('zstd;q=1.0, gzip;q=0.1', 'text/html', big, policy)).toBe('gzip');
	});

	it('leaves a small body alone', () => {
		expect(chooseEncoding('gzip', 'text/html', 100, policy)).toBe(null);
	});

	it('leaves an already compressed type alone', () => {
		expect(chooseEncoding('gzip', 'image/png', big, policy)).toBe(null);
		expect(chooseEncoding('gzip', 'application/wasm', big, policy)).toBe(null);
	});

	it('answers none when the client offers none', () => {
		expect(chooseEncoding(null, 'text/html', big, policy)).toBe(null);
	});
});

describe('compress', () => {
	it('round trips gzip', () => {
		const text = 'a'.repeat(4096);
		const packed = compress('gzip', new TextEncoder().encode(text));
		expect(packed.byteLength).toBeLessThan(text.length);
		expect(new TextDecoder().decode(gunzipSync(packed))).toBe(text);
	});

	it('shrinks html under brotli', () => {
		const text = '<p>hello</p>'.repeat(400);
		const packed = compress('br', new TextEncoder().encode(text));
		expect(packed.byteLength).toBeLessThan(text.length);
	});

	it('refuses an encoding it cannot produce rather than passing bytes through', () => {
		expect(() => compress('zstd', new Uint8Array(1))).toThrow(/unsupported/);
	});
});
