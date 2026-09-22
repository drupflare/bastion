import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import {
	bitString,
	concat,
	context,
	ia5,
	integer,
	octetString,
	oid,
	parse,
	pem,
	sequence,
	set,
	utf8
} from './der';

const OID_CN = '2.5.4.3';
const OID_EXTENSION_REQUEST = '1.2.840.113549.1.9.14';
const OID_SAN = '2.5.29.17';
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';

export interface KeyPair {
	privateKeyPem: string;
	publicKeyPem: string;
}

/**
 * A P-256 key pair.
 *
 * ECDSA rather than RSA because every ACME CA accepts it, the key is a tenth the size, and the
 * handshake costs less on a box terminating TLS for every tenant on it.
 */
export function generateKey(): KeyPair {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	return {
		privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
		publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string
	};
}

function subjectAltName(hosts: string[]): Uint8Array {
	// GeneralName dNSName is [2] IMPLICIT IA5String, so the tag is primitive context 2
	const names = hosts.map((host) => {
		const encoded = ia5(host);
		const copy = new Uint8Array(encoded);
		copy[0] = 0x82;
		return copy;
	});
	return sequence(oid(OID_SAN), octetString(sequence(...names)));
}

/**
 * A PKCS#10 certificate request.
 *
 * Encoded here rather than shelled out to `openssl`, so a cert renewal on a box with no openssl
 * still works and the renewal path has no binary dependency. The subject carries a common name for
 * the CAs that still look at it; the names that matter are in the SAN extension, which is what
 * every ACME CA reads.
 */
export function certificateRequest(privateKeyPem: string, hosts: string[]): Uint8Array {
	if (hosts.length === 0) throw new Error('a certificate request needs at least one host');
	const privateKey = createPrivateKey(privateKeyPem);
	const spki = new Uint8Array(
		createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer
	);

	const subject = sequence(set(sequence(oid(OID_CN), utf8(hosts[0] as string))));
	const attributes = context(
		0,
		sequence(oid(OID_EXTENSION_REQUEST), set(sequence(subjectAltName(hosts))))
	);
	const info = sequence(integer(0), subject, spki, attributes);
	const signature = new Uint8Array(sign('sha256', info, privateKey));

	return sequence(info, sequence(oid(OID_ECDSA_SHA256)), bitString(signature));
}

export function certificateRequestPem(privateKeyPem: string, hosts: string[]): string {
	return pem('CERTIFICATE REQUEST', certificateRequest(privateKeyPem, hosts));
}

/** the base64url DER form ACME's `finalize` wants, which is not PEM */
export function certificateRequestBase64Url(privateKeyPem: string, hosts: string[]): string {
	return Buffer.from(certificateRequest(privateKeyPem, hosts)).toString('base64url');
}

/**
 * The SubjectPublicKeyInfo inside a certificate request.
 *
 * A CA signs the key that arrived in the request rather than one it generated, so reading it out
 * is the first step of any issuance that is not self-signed. Returned as DER because that is
 * exactly what goes into the certificate.
 */
export function publicKeyOfRequest(der: Uint8Array): Uint8Array {
	const outer = parse(der);
	const info = parse(outer.contents);
	// CertificationRequestInfo is version, subject, subjectPKInfo, attributes
	const version = parse(info.contents);
	const subject = parse(info.contents, version.end);
	const spki = parse(info.contents, subject.end);
	return info.contents.subarray(subject.end, spki.end);
}

/** the DNS names a certificate request asks for, read out of its SAN extension */
export function hostsOfRequest(der: Uint8Array): string[] {
	const text = Buffer.from(der).toString('latin1');
	const names: string[] = [];
	// the SAN entries are IA5Strings tagged [2]; scan for them rather than walking every attribute
	for (let i = 0; i < der.length - 2; i++) {
		if (der[i] !== 0x82) continue;
		const length = der[i + 1] as number;
		if (length === 0 || length > 253 || i + 2 + length > der.length) continue;
		const candidate = text.slice(i + 2, i + 2 + length);
		if (/^[a-z0-9.*-]+$/i.test(candidate) && candidate.includes('.')) names.push(candidate);
	}
	return [...new Set(names)];
}

export { concat };
