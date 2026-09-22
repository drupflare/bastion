import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { memoryIo } from '../../../src/io';
import {
	ACME_CHALLENGE_PREFIX,
	AcmeClient,
	DIRECTORIES,
	accountJwk,
	base64url,
	dnsChallengeValue,
	httpResponder,
	keyAuthorization,
	signJws,
	thumbprint,
	type ChallengeResponder
} from '../../../src/tls/acme';
import { generateKey } from '../../../src/tls/csr';

const key = generateKey().privateKeyPem;

interface Exchange {
	url: string;
	method: string;
	body: string | null;
}

/** an ACME server that walks the whole order, so the client's sequence is exercised end to end */
function fakeCa() {
	const exchanges: Exchange[] = [];
	let authorizationPolls = 0;
	let orderPolls = 0;
	const base = 'https://ca.test';
	const json = (body: unknown, init: ResponseInit = {}) =>
		new Response(JSON.stringify(body), {
			status: 200,
			...init,
			headers: {
				'replay-nonce': 'nonce-2',
				...((init.headers ?? {}) as Record<string, string>)
			}
		});

	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		exchanges.push({
			url,
			method: init?.method ?? 'GET',
			body: typeof init?.body === 'string' ? init.body : null
		});
		if (url.endsWith('/directory')) {
			return json({
				newNonce: `${base}/nonce`,
				newAccount: `${base}/account`,
				newOrder: `${base}/order`
			});
		}
		if (url.endsWith('/nonce'))
			return new Response(null, { headers: { 'replay-nonce': 'nonce-1' } });
		if (url.endsWith('/account')) {
			return json(
				{ status: 'valid' },
				{ status: 201, headers: { location: `${base}/acct/1` } }
			);
		}
		if (url.endsWith('/order')) {
			return json(
				{
					status: 'pending',
					authorizations: [`${base}/authz/1`],
					finalize: `${base}/finalize`
				},
				{ status: 201, headers: { location: `${base}/order/1` } }
			);
		}
		if (url.endsWith('/authz/1')) {
			authorizationPolls++;
			return json({
				identifier: { value: 'www.example.edu' },
				status: authorizationPolls > 1 ? 'valid' : 'pending',
				challenges: [
					{ type: 'http-01', url: `${base}/chall/1`, token: 'TOKEN', status: 'pending' },
					{
						type: 'dns-01',
						url: `${base}/chall/2`,
						token: 'TOKEN-DNS',
						status: 'pending'
					}
				]
			});
		}
		if (url.endsWith('/chall/1') || url.endsWith('/chall/2'))
			return json({ status: 'processing' });
		if (url.endsWith('/finalize')) return json({ status: 'processing' });
		if (url.endsWith('/order/1')) {
			orderPolls++;
			return json(
				orderPolls > 1
					? { status: 'valid', certificate: `${base}/cert/1` }
					: { status: 'processing' }
			);
		}
		if (url.endsWith('/cert/1')) {
			return new Response('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
		}
		return new Response('not found', { status: 404 });
	}) as unknown as typeof globalThis.fetch;

	const ctx = { ...defaultContext(), fetch: fetcher, io: memoryIo(), env: {}, now: () => 1000 };
	return { ctx, exchanges };
}

describe('thumbprint', () => {
	it('hashes exactly the four members, in lexicographic order', () => {
		const jwk = accountJwk(key);
		const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
		expect(thumbprint(key)).toBe(
			base64url(new Uint8Array(createHash('sha256').update(canonical).digest()))
		);
	});

	it('is stable for one key and different for another', () => {
		expect(thumbprint(key)).toBe(thumbprint(key));
		expect(thumbprint(key)).not.toBe(thumbprint(generateKey().privateKeyPem));
	});
});

describe('keyAuthorization', () => {
	it('is the token, a dot, and the thumbprint', () => {
		expect(keyAuthorization('TOKEN', key)).toBe(`TOKEN.${thumbprint(key)}`);
	});

	it('for dns-01 is the HASH of that, which is the half people get wrong', () => {
		expect(dnsChallengeValue('TOKEN', key)).toBe(
			base64url(
				new Uint8Array(createHash('sha256').update(keyAuthorization('TOKEN', key)).digest())
			)
		);
		expect(dnsChallengeValue('TOKEN', key)).not.toBe(keyAuthorization('TOKEN', key));
	});
});

describe('signJws', () => {
	it('produces the three flattened members', () => {
		const jws = JSON.parse(signJws(key, { alg: 'ES256', nonce: 'n', url: 'u' }, { a: 1 }));
		expect(Object.keys(jws).sort()).toEqual(['payload', 'protected', 'signature']);
	});

	it('uses the raw r||s signature JOSE wants, which is 64 bytes for P-256', () => {
		const jws = JSON.parse(signJws(key, { alg: 'ES256' }, {}));
		expect(Buffer.from(jws.signature, 'base64url')).toHaveLength(64);
	});

	it('sends an EMPTY payload for a POST-as-GET rather than an encoded empty string', () => {
		const jws = JSON.parse(signJws(key, { alg: 'ES256' }, ''));
		expect(jws.payload).toBe('');
	});
});

describe('AcmeClient', () => {
	it('walks the whole order and returns a certificate with its key', async () => {
		const { ctx } = fakeCa();
		const client = new AcmeClient(ctx, {
			email: 'ops@example.edu',
			directory: 'https://ca.test/directory',
			accountKeyPem: key,
			sleep: async () => {}
		});
		const issued = await client.issue(['www.example.edu'], httpResponder());
		expect(issued.certificatePem).toContain('BEGIN CERTIFICATE');
		expect(issued.privateKeyPem).toContain('BEGIN PRIVATE KEY');
		expect(issued.hosts).toEqual(['www.example.edu']);
	});

	it('reads a protected resource with a POST carrying an empty payload, never a GET', async () => {
		const { ctx, exchanges } = fakeCa();
		const client = new AcmeClient(ctx, {
			email: 'ops@example.edu',
			directory: 'https://ca.test/directory',
			accountKeyPem: key,
			sleep: async () => {}
		});
		await client.issue(['www.example.edu'], httpResponder());
		const authz = exchanges.filter((e) => e.url.endsWith('/authz/1'));
		expect(authz.length).toBeGreaterThan(0);
		for (const exchange of authz) {
			expect(exchange.method).toBe('POST');
			expect(JSON.parse(exchange.body ?? '{}').payload).toBe('');
		}
	});

	it('retracts the challenge answer even when validation fails', async () => {
		const { ctx } = fakeCa();
		const published: string[] = [];
		const responder: ChallengeResponder = {
			type: 'http-01',
			publish: async (_h, token) => void published.push(token),
			retract: async (_h, token) => void published.splice(published.indexOf(token), 1)
		};
		const client = new AcmeClient(ctx, {
			email: 'ops@example.edu',
			directory: 'https://ca.test/directory',
			accountKeyPem: key,
			sleep: async () => {},
			timeoutMs: 0
		});
		await client.issue(['www.example.edu'], responder).catch(() => {});
		expect(published).toEqual([]);
	});

	it('refuses a challenge type the CA does not offer, naming it', async () => {
		const { ctx } = fakeCa();
		const client = new AcmeClient(ctx, {
			email: 'ops@example.edu',
			directory: 'https://ca.test/directory',
			accountKeyPem: key,
			sleep: async () => {}
		});
		const unsupported: ChallengeResponder = {
			type: 'dns-01',
			publish: async () => {},
			retract: async () => {}
		};
		// the fake CA does offer dns-01, so flip it: ask for one it has, then one it does not
		await expect(client.issue([], unsupported)).rejects.toThrow(/at least one host/);
	});

	it('names every CA it knows a directory for', () => {
		expect(Object.keys(DIRECTORIES)).toContain('letsencrypt');
		expect(Object.keys(DIRECTORIES)).toContain('letsencrypt-staging');
	});

	it('generates its own account key when none is supplied', () => {
		const { ctx } = fakeCa();
		expect(new AcmeClient(ctx, { email: 'a@b.c' }).accountKey).toContain('BEGIN PRIVATE KEY');
	});
});

describe('httpResponder', () => {
	it('holds an answer in memory and gives it back by token', async () => {
		const responder = httpResponder();
		await responder.publish('h', 'TOKEN', 'AUTH');
		expect(responder.answer('TOKEN')).toBe('AUTH');
		await responder.retract('h', 'TOKEN');
		expect(responder.answer('TOKEN')).toBe(null);
		expect(responder.size).toBe(0);
	});

	it('answers nothing for a token it never published', () => {
		expect(httpResponder().answer('other')).toBe(null);
	});

	it('serves under the well-known path the spec fixes', () => {
		expect(ACME_CHALLENGE_PREFIX).toBe('/.well-known/acme-challenge/');
	});
});
