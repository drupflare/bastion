import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	amzDate,
	canonicalQuery,
	canonicalRequest,
	canonicalUri,
	EMPTY_PAYLOAD_SHA256,
	signingKey,
	signRequest,
	uriEncode,
	type SigningCredentials
} from '../../../src/drivers/sigv4';

const credentials: SigningCredentials = {
	accessKeyId: 'AKIDEXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
	region: 'us-east-1',
	service: 's3'
};
const at = Date.UTC(2015, 7, 30, 12, 36, 0);

describe('amzDate', () => {
	it('is the basic form with no punctuation and no milliseconds', () => {
		expect(amzDate(at)).toBe('20150830T123600Z');
	});
});

describe('uriEncode', () => {
	it('encodes the five characters encodeURIComponent leaves alone', () => {
		expect(uriEncode("!'()*")).toBe('%21%27%28%29%2A');
	});

	it('leaves the unreserved set alone', () => {
		expect(uriEncode('aZ0-._~')).toBe('aZ0-._~');
	});

	it('keeps a slash only in a path', () => {
		expect(uriEncode('a/b', true)).toBe('a/b');
		expect(uriEncode('a/b')).toBe('a%2Fb');
	});

	it('encodes a multi-byte character one byte at a time', () => {
		expect(uriEncode('é')).toBe('%C3%A9');
	});
});

describe('canonicalQuery', () => {
	it('sorts by name and encodes both halves', () => {
		const url = new URL('https://h/?b=2&a=1&a=0');
		expect(canonicalQuery(url)).toBe('a=0&a=1&b=2');
	});

	it('encodes a value that would otherwise change the signature', () => {
		expect(canonicalQuery(new URL('https://h/?k=a+b'))).toBe('k=a%20b');
	});
});

describe('canonicalUri', () => {
	// minio answered 403 to every key carrying one of these and to no other key, because the old
	// form re-encoded an already-encoded path: `%20` became `%2520`
	it('does not double-encode a path new URL has already encoded', () => {
		expect(canonicalUri('/bucket/a%20b.txt')).toBe('/bucket/a%20b.txt');
	});

	it('encodes the characters new URL leaves raw in a path', () => {
		expect(canonicalUri('/bucket/a+b=c.txt')).toBe('/bucket/a%2Bb%3Dc.txt');
	});

	it('is idempotent, so an encoded and an unencoded caller sign the same bytes', () => {
		const once = canonicalUri('/bucket/a b+c~d/e=f.txt');
		expect(canonicalUri(once)).toBe(once);
		expect(once).toBe('/bucket/a%20b%2Bc~d/e%3Df.txt');
	});

	it('keeps the separators and leaves the unreserved set alone', () => {
		expect(canonicalUri('/a/b/c-d._~')).toBe('/a/b/c-d._~');
	});

	it('preserves an escaped slash inside a segment rather than splitting on it', () => {
		expect(canonicalUri('/bucket/a%2Fb')).toBe('/bucket/a%2Fb');
	});

	it('signs a malformed escape as it arrived rather than throwing', () => {
		expect(canonicalUri('/bucket/a%zz')).toBe('/bucket/a%25zz');
	});
});

describe('canonicalRequest', () => {
	const built = canonicalRequest(
		'GET',
		new URL('https://example.amazonaws.com/'),
		{ Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
		EMPTY_PAYLOAD_SHA256
	);

	it('lowercases and sorts the signed header list', () => {
		expect(built.signedHeaders).toBe('host;x-amz-date');
	});

	it('lays the six fields out in order, with the trailing newline after the headers', () => {
		expect(built.text).toBe(
			[
				'GET',
				'/',
				'',
				'host:example.amazonaws.com',
				'x-amz-date:20150830T123600Z',
				'',
				'host;x-amz-date',
				EMPTY_PAYLOAD_SHA256
			].join('\n')
		);
	});

	it('collapses runs of whitespace inside a header value', () => {
		const built2 = canonicalRequest(
			'GET',
			new URL('https://h/'),
			{ 'x-a': '  a   b  ' },
			EMPTY_PAYLOAD_SHA256
		);
		expect(built2.text).toContain('x-a:a b');
	});

	it('hashes the canonical text, which is what the string to sign carries', () => {
		expect(built.hash).toBe(createHash('sha256').update(built.text).digest('hex'));
	});
});

describe('EMPTY_PAYLOAD_SHA256', () => {
	it('is the SHA-256 of nothing, so a bodyless request signs without hashing', () => {
		expect(EMPTY_PAYLOAD_SHA256).toBe(createHash('sha256').update('').digest('hex'));
	});
});

describe('signingKey', () => {
	it('is derived, so the secret never appears in a request', () => {
		const key = Buffer.from(signingKey(credentials, '20150830')).toString('hex');
		expect(key).not.toContain(Buffer.from(credentials.secretAccessKey).toString('hex'));
		expect(key).toHaveLength(64);
	});

	it('is different for a different day, which is what scopes a leaked signature', () => {
		const a = Buffer.from(signingKey(credentials, '20150830')).toString('hex');
		const b = Buffer.from(signingKey(credentials, '20150831')).toString('hex');
		expect(a).not.toBe(b);
	});
});

describe('signRequest', () => {
	const signed = signRequest(
		'GET',
		new URL('https://b.s3.amazonaws.com/k'),
		{},
		null,
		credentials,
		at
	);

	it('names the algorithm, the scope and the signed headers', () => {
		expect(signed.headers.authorization).toContain('AWS4-HMAC-SHA256');
		expect(signed.headers.authorization).toContain(
			'Credential=AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request'
		);
		expect(signed.headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
	});

	it('sets the content hash header, which S3 requires even with no body', () => {
		expect(signed.headers['x-amz-content-sha256']).toBe(EMPTY_PAYLOAD_SHA256);
	});

	it('is deterministic for one instant, so a retry signs identically', () => {
		const again = signRequest(
			'GET',
			new URL('https://b.s3.amazonaws.com/k'),
			{},
			null,
			credentials,
			at
		);
		expect(again.headers.authorization).toBe(signed.headers.authorization);
	});

	it('changes when the body changes, so a tampered payload fails at the endpoint', () => {
		const withBody = signRequest(
			'PUT',
			new URL('https://b.s3.amazonaws.com/k'),
			{},
			new TextEncoder().encode('hello'),
			credentials,
			at
		);
		expect(withBody.headers['x-amz-content-sha256']).not.toBe(EMPTY_PAYLOAD_SHA256);
		expect(withBody.headers.authorization).not.toBe(signed.headers.authorization);
	});

	it('signs the session token when one is present', () => {
		const temporary = signRequest(
			'GET',
			new URL('https://b.s3.amazonaws.com/k'),
			{},
			null,
			{ ...credentials, sessionToken: 'TOKEN' },
			at
		);
		expect(temporary.headers['x-amz-security-token']).toBe('TOKEN');
		expect(temporary.headers.authorization).toContain('x-amz-security-token');
	});

	it('builds a string to sign with exactly four lines', () => {
		expect(signed.stringToSign.split('\n')).toHaveLength(4);
	});
});
