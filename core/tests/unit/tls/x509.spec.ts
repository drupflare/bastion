import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateKey } from '../../../src/tls/csr';
import { fromPem } from '../../../src/tls/der';
import {
	bigInteger,
	certificate,
	localCa,
	selfSigned,
	signLeaf,
	utcTime
} from '../../../src/tls/x509';

// one key for the volume test below; generating five hundred would cost seconds for nothing
const KEY = generateKey().privateKeyPem;

describe('utcTime', () => {
	it('encodes the two-digit year form X.509 uses below 2050', () => {
		const encoded = utcTime(Date.UTC(2026, 8, 21, 1, 2, 3));
		expect(new TextDecoder().decode(encoded.subarray(2))).toBe('260921010203Z');
	});
});

describe('bigInteger', () => {
	it('pads a value whose top bit is set, so a serial is never read as negative', () => {
		expect(Array.from(bigInteger(new Uint8Array([0x80, 0x01])))).toEqual([2, 3, 0, 0x80, 0x01]);
	});

	it('leaves a value whose top bit is clear alone', () => {
		expect(Array.from(bigInteger(new Uint8Array([0x7f])))).toEqual([2, 1, 0x7f]);
	});

	it('strips a leading zero rather than emitting a non-minimal INTEGER', () => {
		// DER requires the minimal form. Keeping the zero produced a certificate a strict parser
		// refuses, about once in every 256 random serials
		expect(Array.from(bigInteger(new Uint8Array([0x00, 0x41])))).toEqual([2, 1, 0x41]);
		expect(Array.from(bigInteger(new Uint8Array([0x00, 0x00, 0x41])))).toEqual([2, 1, 0x41]);
	});

	it('keeps one zero when stripping would flip the sign', () => {
		expect(Array.from(bigInteger(new Uint8Array([0x00, 0x80])))).toEqual([2, 2, 0, 0x80]);
	});

	it('encodes zero itself as a single zero byte', () => {
		expect(Array.from(bigInteger(new Uint8Array([0x00])))).toEqual([2, 1, 0]);
	});
});

describe('every generated certificate parses', () => {
	it('survives 500 random serials, which is what caught the non-minimal INTEGER', () => {
		// the bug appeared once in about four hundred, so a single-certificate test could not see it
		let refused = 0;
		for (let i = 0; i < 500; i++) {
			const der = certificate({ hosts: ['a.test'], subjectKeyPem: KEY });
			try {
				new X509Certificate(Buffer.from(der));
			} catch {
				refused++;
			}
		}
		expect(refused).toBe(0);
	});
});

describe('selfSigned', () => {
	const made = selfSigned(['www.example.edu', 'lab.example.edu']);
	const parsed = new X509Certificate(made.certificatePem);

	it('parses as a real certificate', () => {
		expect(parsed.subject).toContain('CN=www.example.edu');
	});

	it('carries every host in the SAN, which is what a browser checks', () => {
		expect(parsed.checkHost('www.example.edu')).toBe('www.example.edu');
		expect(parsed.checkHost('lab.example.edu')).toBe('lab.example.edu');
		expect(parsed.checkHost('evil.example')).toBeUndefined();
	});

	it('matches the key it was generated with', () => {
		expect(parsed.checkPrivateKey(createPrivateKey(made.privateKeyPem))).toBe(true);
	});

	it('verifies against its own key, which is what self-signed means', () => {
		expect(parsed.verify(createPublicKey(createPrivateKey(made.privateKeyPem)))).toBe(true);
	});

	it('does not verify against a different key, so the check above can fail', () => {
		expect(parsed.verify(createPublicKey(createPrivateKey(generateKey().privateKeyPem)))).toBe(
			false
		);
	});

	it('is not a CA, so it cannot sign anything else', () => {
		expect(parsed.ca).toBe(false);
	});

	it('expires soon on purpose, because a self-signed certificate nobody replaces is the risk', () => {
		const days = (Date.parse(parsed.validTo) - Date.parse(parsed.validFrom)) / 86_400_000;
		expect(Math.round(days)).toBe(90);
	});

	it('uses a fresh serial each time, so two are distinguishable', () => {
		expect(new X509Certificate(selfSigned(['a.test']).certificatePem).serialNumber).not.toBe(
			parsed.serialNumber
		);
	});

	it('encodes to DER that starts with a SEQUENCE', () => {
		expect(fromPem(made.certificatePem)[0]).toBe(0x30);
	});
});

describe('localCa and signLeaf', () => {
	const ca = localCa('bastion local CA');
	const caCert = new X509Certificate(ca.certificatePem);

	it('is a CA, which a leaf certificate is not', () => {
		expect(caCert.ca).toBe(true);
		expect(new X509Certificate(selfSigned(['a.test']).certificatePem).ca).toBe(false);
	});

	it('signs a leaf that verifies against it', () => {
		const leaf = signLeaf(ca, ['site.local']);
		const leafCert = new X509Certificate(leaf.certificatePem);
		expect(leafCert.verify(caCert.publicKey)).toBe(true);
		expect(leafCert.checkHost('site.local')).toBe('site.local');
	});

	it('does not verify against an unrelated CA', () => {
		const leaf = new X509Certificate(signLeaf(ca, ['site.local']).certificatePem);
		const other = new X509Certificate(localCa('other').certificatePem);
		expect(leaf.verify(other.publicKey)).toBe(false);
	});

	it('ships the CA beside the leaf, so a client gets the whole chain', () => {
		const leaf = signLeaf(ca, ['site.local']);
		expect(leaf.certificatePem.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
	});

	it('hands the key back rather than storing it, because a CA key on this box is interception', () => {
		expect(ca.key.privateKeyPem).toContain('BEGIN PRIVATE KEY');
	});
});

describe('certificate', () => {
	it('honours an explicit validity window', () => {
		const from = Date.UTC(2026, 0, 1);
		const der = certificate({
			hosts: ['a.test'],
			subjectKeyPem: generateKey().privateKeyPem,
			notBefore: from,
			days: 10
		});
		const parsed = new X509Certificate(Buffer.from(der));
		expect(Date.parse(parsed.validFrom)).toBe(from);
		expect(Date.parse(parsed.validTo)).toBe(from + 10 * 86_400_000);
	});
});
