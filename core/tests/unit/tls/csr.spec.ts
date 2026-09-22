import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	certificateRequest,
	certificateRequestBase64Url,
	certificateRequestPem,
	generateKey
} from '../../../src/tls/csr';
import { fromPem, integer, oid, parse, pem, TAG, tlv } from '../../../src/tls/der';

describe('DER primitives', () => {
	it('encodes a short length in one byte and a long one with a count prefix', () => {
		expect(Array.from(tlv(TAG.OCTET_STRING, new Uint8Array(3)))).toEqual([4, 3, 0, 0, 0]);
		const long = tlv(TAG.OCTET_STRING, new Uint8Array(200));
		expect(long[1]).toBe(0x81);
		expect(long[2]).toBe(200);
	});

	it('pads an integer whose top bit is set, so it is not read as negative', () => {
		expect(Array.from(integer(0x80))).toEqual([2, 2, 0, 0x80]);
		expect(Array.from(integer(0x7f))).toEqual([2, 1, 0x7f]);
		expect(Array.from(integer(0))).toEqual([2, 1, 0]);
	});

	it('encodes an OID with the combined first pair and base-128 rest', () => {
		expect(Array.from(oid('2.5.29.17'))).toEqual([6, 3, 85, 29, 17]);
	});

	it('encodes an OID component above 127 across two base-128 bytes', () => {
		expect(Array.from(oid('1.2.840.113549'))).toEqual([6, 6, 42, 134, 72, 134, 247, 13]);
	});

	it('round trips through PEM', () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		const text = pem('TEST', bytes);
		expect(text.startsWith('-----BEGIN TEST-----')).toBe(true);
		expect(Array.from(fromPem(text))).toEqual([1, 2, 3, 4, 5]);
	});

	it('wraps PEM at 64 characters', () => {
		const lines = pem('TEST', new Uint8Array(200)).split('\n').slice(1, -2);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(64);
	});

	it('parses back what it encoded', () => {
		const encoded = tlv(TAG.OCTET_STRING, new Uint8Array([9, 9]));
		const parsed = parse(encoded);
		expect(parsed.tag).toBe(TAG.OCTET_STRING);
		expect(Array.from(parsed.contents)).toEqual([9, 9]);
		expect(parsed.end).toBe(encoded.length);
	});
});

describe('certificateRequest', () => {
	const key = generateKey();
	const der = certificateRequest(key.privateKeyPem, ['www.example.edu', 'lab.example.edu']);

	it('is a SEQUENCE of three fields', () => {
		const outer = parse(der);
		expect(outer.tag).toBe(TAG.SEQUENCE);
		const info = parse(outer.contents);
		const algorithm = parse(outer.contents, info.end);
		const signature = parse(outer.contents, algorithm.end);
		expect(signature.tag).toBe(TAG.BIT_STRING);
		expect(signature.end).toBe(outer.contents.length);
	});

	it('carries a signature the public key verifies, which checks the whole encoding at once', () => {
		const outer = parse(der);
		const info = parse(outer.contents);
		const algorithm = parse(outer.contents, info.end);
		const signature = parse(outer.contents, algorithm.end);
		const publicKey = createPublicKey(createPrivateKey(key.privateKeyPem));
		expect(
			verify(
				'sha256',
				outer.contents.subarray(0, info.end),
				publicKey,
				signature.contents.subarray(1)
			)
		).toBe(true);
	});

	it('does not verify against a different key, so the check above can fail', () => {
		const outer = parse(der);
		const info = parse(outer.contents);
		const algorithm = parse(outer.contents, info.end);
		const signature = parse(outer.contents, algorithm.end);
		const other = createPublicKey(createPrivateKey(generateKey().privateKeyPem));
		expect(
			verify(
				'sha256',
				outer.contents.subarray(0, info.end),
				other,
				signature.contents.subarray(1)
			)
		).toBe(false);
	});

	it('lists every host in the SAN extension', () => {
		const text = Buffer.from(der).toString('latin1');
		expect(text).toContain('www.example.edu');
		expect(text).toContain('lab.example.edu');
	});

	it('refuses to build a request for no hosts', () => {
		expect(() => certificateRequest(key.privateKeyPem, [])).toThrow(/at least one host/);
	});

	it('offers the base64url form ACME finalize wants, not PEM', () => {
		const encoded = certificateRequestBase64Url(key.privateKeyPem, ['a.example.edu']);
		expect(encoded).not.toContain('-----');
		expect(encoded).not.toContain('+');
		expect(encoded).not.toContain('/');
		expect(new Uint8Array(Buffer.from(encoded, 'base64url'))[0]).toBe(0x30);
	});

	it('offers a PEM form for an operator handing it to an internal CA', () => {
		expect(certificateRequestPem(key.privateKeyPem, ['a.example.edu'])).toContain(
			'BEGIN CERTIFICATE REQUEST'
		);
	});
});

describe('generateKey', () => {
	it('makes a P-256 pair usable by node', () => {
		const key = generateKey();
		expect(key.privateKeyPem).toContain('BEGIN PRIVATE KEY');
		expect(createPrivateKey(key.privateKeyPem).asymmetricKeyType).toBe('ec');
	});

	it('makes a different key each time', () => {
		expect(generateKey().privateKeyPem).not.toBe(generateKey().privateKeyPem);
	});
});
