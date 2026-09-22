import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { fixtureResolver } from '../../../src/domains/dns';
import type { DnsProvider, DnsRecord } from '../../../src/domains/provider';
import { recordingListenerHost } from '../../../src/front/listener';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import { generateKey, hostsOfRequest, publicKeyOfRequest } from '../../../src/tls/csr';
import { pem } from '../../../src/tls/der';
import { issueAndStore, responderFor, runOrder } from '../../../src/tls/order';
import { CertificateStore } from '../../../src/tls/store';
import { certificate, localCa } from '../../../src/tls/x509';

const KEY = generateKey().privateKeyPem;
const HOST = 'www.example.edu';

const CA = localCa('fake CA');

/**
 * Signs the key that arrived in the request, which is what a real CA does.
 *
 * Handing back a certificate for a key the client does not hold is the one thing a stub must not
 * do here, because the whole point of checking the CA's answer is that the pair matches.
 */
function signCsr(csrBase64Url: string, overrideHosts?: string[]): string {
	const der = new Uint8Array(Buffer.from(csrBase64Url, 'base64url'));
	return pem(
		'CERTIFICATE',
		certificate({
			hosts: overrideHosts ?? hostsOfRequest(der),
			subjectPublicKeyDer: publicKeyOfRequest(der),
			issuerKeyPem: CA.privateKeyPem,
			issuerName: 'fake CA',
			days: 90
		})
	);
}

/** an ACME server that walks the whole order and hands back a real certificate */
function fakeCa(options: { hosts?: string[]; days?: number } = {}) {
	const base = 'https://ca.test';
	let authorizationPolls = 0;
	let orderPolls = 0;
	const json = (body: unknown, init: ResponseInit = {}) =>
		new Response(JSON.stringify(body), {
			status: 200,
			...init,
			headers: { 'replay-nonce': 'n2', ...((init.headers ?? {}) as Record<string, string>) }
		});

	let issued = '';
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/directory')) {
			return json({
				newNonce: `${base}/nonce`,
				newAccount: `${base}/account`,
				newOrder: `${base}/order`
			});
		}
		if (url.endsWith('/nonce'))
			return new Response(null, { headers: { 'replay-nonce': 'n1' } });
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
				identifier: { value: HOST },
				status: authorizationPolls > 1 ? 'valid' : 'pending',
				challenges: [
					{ type: 'http-01', url: `${base}/chall/1`, token: 'TOKEN', status: 'pending' },
					{ type: 'dns-01', url: `${base}/chall/2`, token: 'TOKEN', status: 'pending' }
				]
			});
		}
		if (url.includes('/chall/')) return json({ status: 'processing' });
		if (url.endsWith('/finalize')) {
			const jws = JSON.parse(String(init?.body ?? '{}')) as { payload: string };
			const payload = JSON.parse(Buffer.from(jws.payload, 'base64url').toString()) as {
				csr: string;
			};
			issued = signCsr(payload.csr, options.hosts);
			return json({ status: 'processing' });
		}
		if (url.endsWith('/order/1')) {
			orderPolls++;
			return json(
				orderPolls > 1
					? { status: 'valid', certificate: `${base}/cert/1` }
					: { status: 'processing' }
			);
		}
		if (url.endsWith('/cert/1')) return new Response(issued);
		return new Response('not found', { status: 404 });
	}) as unknown as typeof globalThis.fetch;
}

function harness(options: { hosts?: string[] } = {}) {
	const files = memoryFiles();
	const io = memoryIo();
	return {
		files,
		io,
		ctx: {
			...defaultContext(),
			fetch: fakeCa(options),
			files,
			io,
			env: {},
			now: () => Date.now()
		}
	};
}

const provider: DnsProvider = {
	id: () => 'fake',
	zoneFor: async () => 'z',
	list: async () => [],
	upsert: async (_zone, record) => ({ ...record, id: 'r1' }),
	remove: async () => {}
};

const common = {
	hosts: [HOST],
	email: 'ops@example.edu',
	directory: 'https://ca.test/directory',
	accountKeyPem: KEY,
	sleep: async () => {}
};

describe('responderFor', () => {
	it('uses the provider for dns-01 and reports it as automatable', () => {
		const { ctx } = harness();
		const built = responderFor(ctx, { ...common, strategy: 'acme-dns-01', provider });
		expect(built.responder.type).toBe('dns-01');
		expect(built.manual).toBe(false);
	});

	it('refuses dns-01 with no provider rather than silently going manual', () => {
		const { ctx } = harness();
		expect(() => responderFor(ctx, { ...common, strategy: 'acme-dns-01' })).toThrow(
			/needs a provider/
		);
	});

	it('marks the manual path as manual, so a renewal loop does not schedule it', () => {
		const { ctx } = harness();
		const built = responderFor(ctx, { ...common, strategy: 'acme-dns-01-manual' });
		expect(built.manual).toBe(true);
	});

	it('prints the record to publish on the manual path', async () => {
		const { ctx, io } = harness();
		const built = responderFor(ctx, {
			...common,
			strategy: 'acme-dns-01-manual',
			resolver: fixtureResolver({
				txt: { '_acme-challenge.www.example.edu': ['V'] }
			} as never),
			watchAttempts: 1
		});
		await built.responder.publish(HOST, 'T', 'V');
		expect(io.outText()).toContain('TXT _acme-challenge.www.example.edu "V"');
	});

	it('binds a standalone listener for http-01 when one is offered', () => {
		const { ctx } = harness();
		const host = recordingListenerHost();
		const built = responderFor(ctx, {
			...common,
			strategy: 'acme-http-01',
			listenerHost: host
		});
		expect(host.bound).toHaveLength(1);
		expect(built.responder.type).toBe('http-01');
	});

	it('binds nothing for http-01 when bastion is already serving', () => {
		const { ctx } = harness();
		const built = responderFor(ctx, { ...common, strategy: 'acme-http-01' });
		expect(built.responder.type).toBe('http-01');
		expect(built.manual).toBe(false);
	});

	it('refuses a strategy that is not an ACME one', () => {
		const { ctx } = harness();
		expect(() => responderFor(ctx, { ...common, strategy: 'self-signed' })).toThrow(
			/not an ACME/
		);
	});
});

describe('runOrder', () => {
	it('walks the order and returns the certificate', async () => {
		const { ctx } = harness();
		const result = await runOrder(ctx, { ...common, strategy: 'acme-dns-01', provider });
		expect(result.certificate.certificatePem).toContain('BEGIN CERTIFICATE');
		expect(result.strategy).toBe('acme-dns-01');
	});

	it('releases a standalone listener whether the order worked or not', async () => {
		const host = recordingListenerHost();
		const { ctx } = harness();
		await runOrder(ctx, { ...common, strategy: 'acme-http-01', listenerHost: host });
		expect(host.stopped).toHaveLength(1);
	});

	it('releases the listener after a failure too, so a retry is not blocked by a bound port', async () => {
		const host = recordingListenerHost();
		const ctx = {
			...defaultContext(),
			fetch: (async () =>
				new Response('down', { status: 500 })) as unknown as typeof globalThis.fetch,
			files: memoryFiles(),
			io: memoryIo(),
			env: {},
			now: () => Date.now()
		};
		await runOrder(ctx, { ...common, strategy: 'acme-http-01', listenerHost: host }).catch(
			() => {}
		);
		expect(host.stopped).toHaveLength(1);
	});
});

describe('issueAndStore', () => {
	it('stores what the CA returned, marked as an ACME certificate', async () => {
		const { ctx, files } = harness();
		const store = new CertificateStore(ctx, '/certs');
		const { stored } = await issueAndStore(ctx, store, {
			...common,
			strategy: 'acme-dns-01',
			provider
		});
		expect(stored.source).toBe('acme');
		expect(files.exists(`/certs/${HOST}/fullchain.pem`)).toBe(true);
		expect(store.load(HOST)?.hosts).toContain(HOST);
	});

	it('checks the CA s answer the same way an import is checked', async () => {
		// a CA that returns a certificate for the wrong name
		const { ctx } = harness({ hosts: ['somewhere.else'] });
		const store = new CertificateStore(ctx, '/certs');
		await expect(
			issueAndStore(ctx, store, { ...common, strategy: 'acme-dns-01', provider })
		).rejects.toThrow(/will not install/);
	});

	it('stores nothing when the answer is refused', async () => {
		const { ctx, files } = harness({ hosts: ['somewhere.else'] });
		const store = new CertificateStore(ctx, '/certs');
		await issueAndStore(ctx, store, { ...common, strategy: 'acme-dns-01', provider }).catch(
			() => {}
		);
		expect(files.exists(`/certs/${HOST}/fullchain.pem`)).toBe(false);
	});

	it('records the real expiry from the certificate rather than assuming a fixed window', async () => {
		const { ctx } = harness();
		const store = new CertificateStore(ctx, '/certs');
		const { stored } = await issueAndStore(ctx, store, {
			...common,
			strategy: 'acme-dns-01',
			provider
		});
		const days = Math.round((stored.expiresAt - stored.issuedAt) / 86_400_000);
		expect(days).toBe(90);
	});

	it('retracts the challenge record after the order finishes', async () => {
		const removed: DnsRecord[] = [];
		const watched: DnsProvider = { ...provider, remove: async (_z, r) => void removed.push(r) };
		const { ctx } = harness();
		await issueAndStore(ctx, new CertificateStore(ctx, '/certs'), {
			...common,
			strategy: 'acme-dns-01',
			provider: watched
		});
		expect(removed).toHaveLength(1);
	});
});
