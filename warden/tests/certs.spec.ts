import {
	EXIT,
	certificate,
	hostsOfRequest,
	localCa,
	memoryFiles,
	memoryIo,
	pem,
	publicKeyOfRequest,
	recordingListenerHost,
	scriptedRunner,
	type Context
} from '@drupflare/bastion';
import { describe, expect, it } from 'vitest';
import { runCertIssue } from '../src/commands/domains';
import { runCertRenew } from '../src/commands/maintain';
import { run } from '../src/run';

const HOST = 'alpha.sites.example.edu';
const CA = localCa('fake CA');

/** the whole suite runs on a frozen clock, so a certificate's validity window is deterministic */
const NOW = Date.UTC(2026, 8, 21);
/** 10 days before the 90-day fixture expires, which is inside the expiry ladder's warn rung */
const RENEWAL_TIME = Date.UTC(2026, 11, 10);

const CONFIG = `
version: 1
mode: solo
state: /var/lib/bastion
domains:
  primary: sites.example.edu
  provider:
    driver: cloudflare
    apiToken: token
tls:
  acme:
    email: ops@example.edu
tenants:
  - name: acme
    sites:
      - host: ${HOST}
        bundle: ./payload.tar.gz
`;

const NO_ACME = CONFIG.replace('    email: ops@example.edu', '    email: ""');

function signCsr(csrBase64Url: string, overrideHosts?: string[]): string {
	const der = new Uint8Array(Buffer.from(csrBase64Url, 'base64url'));
	return pem(
		'CERTIFICATE',
		certificate({
			hosts: overrideHosts ?? hostsOfRequest(der),
			subjectPublicKeyDer: publicKeyOfRequest(der),
			issuerKeyPem: CA.privateKeyPem,
			issuerName: 'fake CA',
			notBefore: NOW,
			days: 90
		})
	);
}

/** the cloudflare API and an ACME CA on one seam, because `cert issue` drives both */
function fakeWorld(options: { hosts?: string[]; caDown?: boolean } = {}) {
	const base = 'https://ca.test';
	const calls: string[] = [];
	let authorizationPolls = 0;
	let orderPolls = 0;
	let issued = '';
	const json = (body: unknown, init: ResponseInit = {}) =>
		new Response(JSON.stringify(body), {
			status: 200,
			...init,
			headers: { 'replay-nonce': 'n2', ...((init.headers ?? {}) as Record<string, string>) }
		});
	const ok = (result: unknown) => json({ success: true, errors: [], result });

	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push(`${init?.method ?? 'GET'} ${url}`);

		if (url.includes('api.cloudflare.com')) {
			if (url.includes('/zones?')) return ok([{ id: 'z1', name: 'sites.example.edu' }]);
			if (url.includes('/dns_records?')) return ok([]);
			return ok({ id: 'r1' });
		}
		if (url.endsWith('/directory')) {
			if (options.caDown === true) return new Response('down', { status: 503 });
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

	return { fetch, calls };
}

function harness(
	files: Record<string, string> = { '/srv/bastion.yml': CONFIG },
	options: { hosts?: string[]; caDown?: boolean } = {}
): {
	ctx: Context;
	io: ReturnType<typeof memoryIo>;
	files: ReturnType<typeof memoryFiles>;
	calls: string[];
} {
	const io = memoryIo();
	const store = memoryFiles(files);
	const world = fakeWorld(options);
	return {
		io,
		files: store,
		calls: world.calls,
		ctx: {
			io,
			files: store,
			runner: scriptedRunner(),
			fetch: world.fetch,
			env: {},
			cwd: '/srv',
			now: () => NOW
		}
	};
}

const globals = { staging: true, json: true, sleep: async () => {} };

describe('cert issue', () => {
	it('drives a whole ACME order and installs the answer', async () => {
		const { ctx, files, io } = harness();
		await runCertIssue(ctx, globals, HOST);
		expect(files.exists(`/var/lib/bastion/certs/${HOST}/fullchain.pem`)).toBe(true);
		const emitted = JSON.parse(io.outText()) as { strategy: string; hosts: string[] };
		expect(emitted.strategy).toBe('acme-dns-01');
		expect(emitted.hosts).toContain(HOST);
	});

	it('publishes the challenge through the configured DNS provider', async () => {
		const { ctx, calls } = harness();
		await runCertIssue(ctx, globals, HOST);
		expect(calls.some((call) => call.startsWith('POST https://api.cloudflare.com'))).toBe(true);
	});

	it('keeps one ACME account key rather than registering a new account each run', async () => {
		const { ctx, files } = harness();
		await runCertIssue(ctx, globals, HOST);
		const first = files.readText('/var/lib/bastion/certs/acme-account.key');
		await runCertIssue(ctx, { ...globals, force: true }, HOST);
		expect(files.readText('/var/lib/bastion/certs/acme-account.key')).toBe(first);
	});

	it('keeps the account key readable only by bastion', async () => {
		const { ctx, files } = harness();
		await runCertIssue(ctx, globals, HOST);
		expect(files.mode('/var/lib/bastion/certs/acme-account.key')).toBe(0o600);
	});

	it('refuses a name no public CA can validate, and names the command that does apply', async () => {
		const { ctx } = harness({ '/srv/bastion.yml': NO_ACME });
		await expect(runCertIssue(ctx, globals, HOST)).rejects.toThrow(
			/cannot be issued over ACME/
		);
	});

	it('refuses to install a certificate the CA issued for a different name', async () => {
		const { ctx, files } = harness(
			{ '/srv/bastion.yml': CONFIG },
			{ hosts: ['somewhere.else'] }
		);
		await expect(runCertIssue(ctx, globals, HOST)).rejects.toThrow(/will not install/);
		expect(files.exists(`/var/lib/bastion/certs/${HOST}/fullchain.pem`)).toBe(false);
	});

	it('exits 2 through the CLI when the host is missing', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['cert', 'issue'])).toBe(EXIT.USAGE);
	});
});

describe('cert renew', () => {
	async function issued(): Promise<ReturnType<typeof harness>> {
		const bench = harness();
		await runCertIssue(bench.ctx, globals, HOST);
		return bench;
	}

	it('renews over ACME rather than reporting what it would do', async () => {
		const bench = await issued();
		// move the clock to inside the expiry ladder
		const ctx = { ...bench.ctx, now: () => RENEWAL_TIME };
		const code = await runCertRenew(ctx, { ...globals, staging: true });
		const outcomes = (
			JSON.parse(bench.io.outText().split('\n').pop() ?? '{}') as {
				outcomes: { action: string }[];
			}
		).outcomes;
		expect(outcomes.map((row) => row.action)).toEqual(['renewed']);
		expect(code).toBe(EXIT.OK);
	});

	it('reports a CA failure as a finding rather than throwing away the run', async () => {
		const bench = await issued();
		const world = fakeWorld({ caDown: true });
		const ctx = { ...bench.ctx, fetch: world.fetch, now: () => RENEWAL_TIME };
		const code = await runCertRenew(ctx, { ...globals, staging: true });
		expect(code).toBe(EXIT.FINDING);
		expect(bench.io.outText()).toContain('failed');
	});

	it('leaves an imported chain alone', async () => {
		const bench = await issued();
		const path = `/var/lib/bastion/certs/${HOST}/meta.json`;
		const meta = JSON.parse(bench.files.readText(path)) as Record<string, unknown>;
		bench.files.writeText(path, JSON.stringify({ ...meta, source: 'imported' }));
		const ctx = { ...bench.ctx, now: () => RENEWAL_TIME };
		expect(await runCertRenew(ctx, { ...globals, staging: true })).toBe(EXIT.FINDING);
		expect(bench.io.outText()).toContain('will not replace it');
	});
});

describe('the http-01 path binds a listener rather than assuming one', () => {
	it('binds and releases a standalone listener', async () => {
		const noProvider = CONFIG.replace('    driver: cloudflare', '    driver: none').replace(
			'    apiToken: token\n',
			''
		);
		const { ctx } = harness({ '/srv/bastion.yml': noProvider });
		const host = recordingListenerHost();
		await runCertIssue(ctx, { ...globals, listenerHost: host }, HOST);
		expect(host.bound).toHaveLength(1);
		expect(host.stopped).toHaveLength(1);
	});
});
