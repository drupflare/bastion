import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { generateKey, type KeyPair } from './csr';
import {
	bitString,
	context,
	ia5,
	integer,
	octetString,
	oid,
	pem,
	sequence,
	set,
	tlv,
	utf8
} from './der';

const OID = {
	commonName: '2.5.4.3',
	organisation: '2.5.4.10',
	ecdsaSha256: '1.2.840.10045.4.3.2',
	basicConstraints: '2.5.29.19',
	keyUsage: '2.5.29.15',
	extendedKeyUsage: '2.5.29.37',
	subjectAltName: '2.5.29.17',
	serverAuth: '1.3.6.1.5.5.7.3.1',
	clientAuth: '1.3.6.1.5.5.7.3.2'
} as const;

const UTC_TIME = 0x17;

/** `YYMMDDHHMMSSZ`, which is what X.509 uses below 2050 */
export function utcTime(at: number): Uint8Array {
	const date = new Date(at);
	const pad = (n: number): string => String(n).padStart(2, '0');
	const text =
		`${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
		`${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
	return tlv(UTC_TIME, new TextEncoder().encode(text));
}

/**
 * A positive INTEGER from raw bytes, for a serial too large for a JS number.
 *
 * Leading zero bytes are stripped BEFORE the sign padding is decided. DER requires the minimal
 * encoding, so a leading `0x00` in front of a byte whose top bit is clear is invalid, and a random
 * 16-byte serial begins with `0x00` about once in every 256. That produced a certificate a strict
 * parser refuses roughly one time in four hundred, which presents as an occasional unexplained TLS
 * failure rather than as anything reproducible.
 */
export function bigInteger(bytes: Uint8Array): Uint8Array {
	let at = 0;
	while (at < bytes.length - 1 && bytes[at] === 0) at++;
	const trimmed = bytes.subarray(at);
	const first = trimmed[0] ?? 0;
	return tlv(0x02, (first & 0x80) !== 0 ? new Uint8Array([0, ...trimmed]) : trimmed);
}

function name(commonName: string, organisation?: string): Uint8Array {
	const parts = [set(sequence(oid(OID.commonName), utf8(commonName)))];
	if (organisation !== undefined) {
		parts.push(set(sequence(oid(OID.organisation), utf8(organisation))));
	}
	return sequence(...parts);
}

function subjectAltName(hosts: string[]): Uint8Array {
	const names = hosts.map((host) => {
		const encoded = ia5(host);
		const copy = new Uint8Array(encoded);
		copy[0] = 0x82;
		return copy;
	});
	return sequence(oid(OID.subjectAltName), octetString(sequence(...names)));
}

function basicConstraints(ca: boolean): Uint8Array {
	return sequence(
		oid(OID.basicConstraints),
		// critical
		tlv(0x01, new Uint8Array([0xff])),
		octetString(ca ? sequence(tlv(0x01, new Uint8Array([0xff]))) : sequence())
	);
}

function keyUsage(ca: boolean): Uint8Array {
	// digitalSignature + keyEncipherment for a leaf; keyCertSign + cRLSign for a CA
	const bits = ca ? new Uint8Array([0x01, 0x06]) : new Uint8Array([0x05, 0xa0]);
	return sequence(
		oid(OID.keyUsage),
		tlv(0x01, new Uint8Array([0xff])),
		octetString(tlv(0x03, bits))
	);
}

function extendedKeyUsage(): Uint8Array {
	return sequence(
		oid(OID.extendedKeyUsage),
		octetString(sequence(oid(OID.serverAuth), oid(OID.clientAuth)))
	);
}

export interface CertificateOptions {
	hosts: string[];
	/** the key the certificate is FOR; omit when `subjectPublicKeyDer` is given */
	subjectKeyPem?: string;
	/**
	 * The subject's SubjectPublicKeyInfo, for signing a key this process does not hold.
	 *
	 * That is what a CA actually does: it signs a public key that arrived in a request. Without
	 * this the encoder could only ever certify its own key, which is the self-signed case and not
	 * the interesting one.
	 */
	subjectPublicKeyDer?: Uint8Array;
	/** the key that SIGNS it; the subject key for a self-signed certificate */
	issuerKeyPem?: string;
	issuerName?: string;
	organisation?: string;
	notBefore?: number;
	days?: number;
	ca?: boolean;
}

/**
 * An X.509 certificate, signed by a key this process holds.
 *
 * This exists for the two cases ACME cannot serve: a `.local` or lab install with no
 * internet-reachable name, and a host with no CA at all. It is NOT a path to a publicly trusted
 * certificate and does not pretend to be one; a browser will refuse it until its issuer is trusted
 * deliberately.
 *
 * Encoded here rather than shelled out to `openssl` for the same reason the certificate request is:
 * a lab box with no openssl still needs to come up, and a renewal path with a binary dependency is
 * a renewal path that fails on the one machine nobody checked.
 */
export function certificate(options: CertificateOptions): Uint8Array {
	const signingKeyPem = options.issuerKeyPem ?? options.subjectKeyPem;
	if (signingKeyPem === undefined) {
		throw new Error('a certificate needs a key to sign it: pass issuerKeyPem or subjectKeyPem');
	}
	const issuerKey = createPrivateKey(signingKeyPem);
	const spki =
		options.subjectPublicKeyDer ??
		new Uint8Array(
			createPublicKey(createPrivateKey(options.subjectKeyPem as string)).export({
				type: 'spki',
				format: 'der'
			}) as Buffer
		);

	const from = options.notBefore ?? Date.now();
	const until = from + (options.days ?? 825) * 86_400_000;
	const commonName = options.hosts[0] ?? 'bastion';

	const extensions = [
		basicConstraints(options.ca === true),
		keyUsage(options.ca === true),
		...(options.ca === true ? [] : [extendedKeyUsage()]),
		subjectAltName(options.hosts)
	];

	const tbs = sequence(
		context(0, integer(2)),
		bigInteger(new Uint8Array(randomBytes(16))),
		sequence(oid(OID.ecdsaSha256)),
		name(options.issuerName ?? commonName, options.organisation),
		sequence(utcTime(from), utcTime(until)),
		name(commonName, options.organisation),
		spki,
		context(3, sequence(...extensions))
	);

	const signature = new Uint8Array(sign('sha256', tbs, issuerKey));
	return sequence(tbs, sequence(oid(OID.ecdsaSha256)), bitString(signature));
}

export interface SelfSigned {
	certificatePem: string;
	privateKeyPem: string;
	hosts: string[];
}

/** a self-signed leaf, which is what a lab install gets when nothing else is configured */
export function selfSigned(
	hosts: string[],
	options: { days?: number; now?: number } = {}
): SelfSigned {
	const key = generateKey();
	const der = certificate({
		hosts,
		subjectKeyPem: key.privateKeyPem,
		organisation: 'bastion',
		...(options.now === undefined ? {} : { notBefore: options.now }),
		// deliberately short: a self-signed certificate that lasts years is one nobody replaces
		days: options.days ?? 90
	});
	return {
		certificatePem: pem('CERTIFICATE', der),
		privateKeyPem: key.privateKeyPem,
		hosts
	};
}

export interface LocalCa {
	certificatePem: string;
	privateKeyPem: string;
}

/**
 * A local CA, for generating OFF the bastion host.
 *
 * The key is returned rather than stored, because a CA key on a multi-tenant box is an
 * interception capability against every client that trusted it. `bastion cert trust` installs the
 * public half and refuses a file carrying a key, which is the other end of this rule.
 */
export function localCa(name: string, days = 3650): LocalCa & { key: KeyPair } {
	const key = generateKey();
	const der = certificate({
		hosts: [name],
		subjectKeyPem: key.privateKeyPem,
		issuerName: name,
		organisation: 'bastion local CA',
		days,
		ca: true
	});
	return { certificatePem: pem('CERTIFICATE', der), privateKeyPem: key.privateKeyPem, key };
}

/** a leaf signed by a local CA, so a lab can serve a name its clients already trust */
export function signLeaf(ca: LocalCa, hosts: string[], days = 825): SelfSigned {
	const key = generateKey();
	const der = certificate({
		hosts,
		subjectKeyPem: key.privateKeyPem,
		issuerKeyPem: ca.privateKeyPem,
		issuerName: hostFromPem(ca.certificatePem) ?? 'bastion local CA',
		days
	});
	return {
		certificatePem: `${pem('CERTIFICATE', der)}${ca.certificatePem}`,
		privateKeyPem: key.privateKeyPem,
		hosts
	};
}

function hostFromPem(certificatePem: string): string | null {
	const match = /CN=([^,\n]+)/.exec(certificatePem);
	return match?.[1] ?? null;
}
