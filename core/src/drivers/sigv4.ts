import { createHash, createHmac } from 'node:crypto';

export interface SigningCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	region: string;
	service: string;
}

export const EMPTY_PAYLOAD_SHA256 =
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const ALGORITHM = 'AWS4-HMAC-SHA256';

function sha256Hex(data: Uint8Array | string): string {
	return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Uint8Array | string, data: string): Uint8Array {
	return new Uint8Array(createHmac('sha256', key).update(data).digest());
}

/** `20150830T123600Z`, which is the only timestamp form the algorithm accepts */
export function amzDate(at: number): string {
	return new Date(at)
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '');
}

/**
 * Percent-encoding as the algorithm defines it, which is not `encodeURIComponent`.
 *
 * `!`, `'`, `(`, `)` and `*` are left alone by `encodeURIComponent` and must be encoded here, and
 * a path segment keeps its `/`. Getting this wrong produces a signature mismatch on exactly the
 * keys that contain those characters and on no others, which is the kind of bug that ships.
 */
export function uriEncode(value: string, keepSlash = false): string {
	let out = '';
	for (const char of value) {
		if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === '/')) {
			out += char;
			continue;
		}
		for (const byte of new TextEncoder().encode(char)) {
			out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
		}
	}
	return out;
}

/**
 * The canonical URI, from a path that may already be percent-encoded or may not.
 *
 * `new URL()` encodes a space to `%20` and leaves `+`, `=`, `!`, `'`, `(`, `)` and `*` raw, so
 * neither the pathname as it stands nor a straight re-encode of it is the canonical form: the
 * first under-encodes and the second turns `%20` into `%2520`. Decoding each segment before
 * encoding it makes this idempotent, so a caller that already encoded and one that did not both
 * sign the same bytes the server will.
 *
 * Measured against a real minio, which answered 403 to every key containing a space, a `+` or an
 * `=` and to no other key. The gate lane could not see it: a stub accepts whatever it is sent.
 */
export function canonicalUri(pathname: string): string {
	return pathname
		.split('/')
		.map((segment) => {
			let decoded = segment;
			try {
				decoded = decodeURIComponent(segment);
			} catch {
				// a malformed escape is not ours to repair; sign it as it arrived
			}
			return uriEncode(decoded);
		})
		.join('/');
}

export function canonicalQuery(url: URL): string {
	const pairs: [string, string][] = [];
	for (const [key, value] of url.searchParams) pairs.push([uriEncode(key), uriEncode(value)]);
	pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
	return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

export interface CanonicalRequest {
	text: string;
	signedHeaders: string;
	hash: string;
}

export function canonicalRequest(
	method: string,
	url: URL,
	headers: Record<string, string>,
	payloadHash: string
): CanonicalRequest {
	const lower = Object.entries(headers)
		.map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as [string, string])
		.sort((a, b) => a[0].localeCompare(b[0]));
	const signedHeaders = lower.map(([k]) => k).join(';');
	const text = [
		method.toUpperCase(),
		canonicalUri(url.pathname),
		canonicalQuery(url),
		`${lower.map(([k, v]) => `${k}:${v}`).join('\n')}\n`,
		signedHeaders,
		payloadHash
	].join('\n');
	return { text, signedHeaders, hash: sha256Hex(text) };
}

export function signingKey(credentials: SigningCredentials, date: string): Uint8Array {
	const initial = hmac(`AWS4${credentials.secretAccessKey}`, date);
	const regional = hmac(initial, credentials.region);
	const serviced = hmac(regional, credentials.service);
	return hmac(serviced, 'aws4_request');
}

export interface SignedRequest {
	headers: Record<string, string>;
	/** kept so a spec and a failed-request log can show what was actually signed */
	canonical: string;
	stringToSign: string;
}

/**
 * Signs a request the way S3 and every S3-compatible endpoint expects.
 *
 * One signer serves s3, r2, b2, gcs in its interoperability mode and minio, because all five speak
 * the same protocol; the driver ids differ in their endpoint and region defaults and in nothing
 * else. Azure is the exception and has its own signer, because SharedKey is a different scheme
 * rather than a different endpoint.
 */
export function signRequest(
	method: string,
	url: URL,
	headers: Record<string, string>,
	payload: Uint8Array | null,
	credentials: SigningCredentials,
	at: number
): SignedRequest {
	const stamp = amzDate(at);
	const date = stamp.slice(0, 8);
	const payloadHash = payload === null ? EMPTY_PAYLOAD_SHA256 : sha256Hex(payload);
	const full: Record<string, string> = {
		...headers,
		host: url.host,
		'x-amz-date': stamp,
		'x-amz-content-sha256': payloadHash
	};
	if (credentials.sessionToken !== undefined)
		full['x-amz-security-token'] = credentials.sessionToken;

	const canonical = canonicalRequest(method, url, full, payloadHash);
	const scope = `${date}/${credentials.region}/${credentials.service}/aws4_request`;
	const stringToSign = [ALGORITHM, stamp, scope, canonical.hash].join('\n');
	const signature = Buffer.from(hmac(signingKey(credentials, date), stringToSign)).toString(
		'hex'
	);

	return {
		headers: {
			...full,
			authorization:
				`${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
				`SignedHeaders=${canonical.signedHeaders}, Signature=${signature}`
		},
		canonical: canonical.text,
		stringToSign
	};
}
