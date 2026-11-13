import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../../src/audit/log';
import { BastionError } from '../../../src/errors';
import {
	CLAIM_PATH,
	CONTRACT_HEADER,
	claim,
	isLoopbackHost,
	parseClaimUrl
} from '../../../src/pair/claim';
import { NODE_KEY_SECRET, PairStore } from '../../../src/pair/store';
import { fromBase64Url } from '../../../src/pair/wire';
import { STATE, newBox, publicDns, type Box } from './plane';

const TOKEN = 'dGVzdC1jbGFpbS10b2tlbi1mb3Itc3BlY3M';
const DASHBOARD_KEY = 'r2EXtK8adXShcS1LcXu6-pg-dlzFrrSaWFSUBElQY2s';

function refusal(run: () => unknown): BastionError {
	try {
		run();
	} catch (error) {
		return error as BastionError;
	}
	throw new Error('expected a refusal');
}

describe('parseClaimUrl', () => {
	it('takes the token from the fragment', () => {
		const parsed = parseClaimUrl(`https://dash.example.edu/p#${TOKEN}`);
		expect(parsed).toEqual({
			origin: 'https://dash.example.edu',
			endpoint: `https://dash.example.edu${CLAIM_PATH}`,
			token: TOKEN
		});
	});

	it('keeps the token out of the endpoint it will request', () => {
		const parsed = parseClaimUrl(`https://dash.example.edu/p#${TOKEN}`);
		expect(parsed.endpoint).not.toContain(TOKEN);
		expect(parsed.origin).not.toContain(TOKEN);
	});

	it('refuses plaintext for a host that is not loopback', () => {
		const error = refusal(() => parseClaimUrl(`http://dash.example.edu/p#${TOKEN}`));
		expect(error.code).toBe('pairing-refused');
		expect(error.message).toContain('plaintext');
	});

	it('accepts plaintext for loopback only', () => {
		expect(parseClaimUrl(`http://127.0.0.1:3000/p#${TOKEN}`).origin).toBe(
			'http://127.0.0.1:3000'
		);
		expect(parseClaimUrl(`http://localhost:3000/p#${TOKEN}`).origin).toBe(
			'http://localhost:3000'
		);
		expect(parseClaimUrl(`http://[::1]:3000/p#${TOKEN}`).origin).toBe('http://[::1]:3000');
		expect(isLoopbackHost('10.0.0.1')).toBe(false);
		expect(isLoopbackHost('127.evil.example.edu')).toBe(false);
	});

	it('refuses a scheme that is neither', () => {
		expect(refusal(() => parseClaimUrl(`ftp://dash.example.edu/p#${TOKEN}`)).message).toContain(
			'ftp'
		);
	});

	it('refuses an address with no token, a query token, or a token of the wrong shape', () => {
		expect(refusal(() => parseClaimUrl('https://dash.example.edu/p')).message).toContain(
			'no claim token'
		);
		expect(
			refusal(() => parseClaimUrl(`https://dash.example.edu/p?t=${TOKEN}`)).message
		).toContain('query');
		expect(refusal(() => parseClaimUrl('https://dash.example.edu/p#short')).message).toContain(
			'shape'
		);
	});

	it('refuses an address that is not a url, and one with credentials', () => {
		expect(refusal(() => parseClaimUrl('not a url')).code).toBe('usage');
		expect(
			refusal(() => parseClaimUrl(`https://user:pw@dash.example.edu/p#${TOKEN}`)).message
		).toContain('user name');
	});

	it('never repeats the token in a refusal', () => {
		for (const text of [
			`http://dash.example.edu/p#${TOKEN}`,
			`ftp://dash.example.edu/p#${TOKEN}`,
			`https://dash.example.edu/p?t=${TOKEN}#${TOKEN}`,
			`https://user:pw@dash.example.edu/p#${TOKEN}`
		]) {
			expect(refusal(() => parseClaimUrl(text)).message).not.toContain(TOKEN);
		}
	});
});

interface Stub {
	server: Server;
	origin: string;
	requests: {
		method?: string;
		url?: string;
		headers: IncomingMessage['headers'];
		body: string;
	}[];
}

let stubs: Server[] = [];
afterEach(async () => {
	await Promise.all(stubs.map((server) => new Promise((resolve) => server.close(resolve))));
	stubs = [];
});

async function control(
	reply: (body: Record<string, unknown>) => { status: number; json: unknown }
): Promise<Stub> {
	const requests: Stub['requests'] = [];
	const server = createServer((request, response) => {
		let body = '';
		request.on('data', (chunk) => (body += chunk));
		request.on('end', () => {
			requests.push({
				method: request.method,
				url: request.url,
				headers: request.headers,
				body
			});
			const answer = reply(JSON.parse(body) as Record<string, unknown>);
			response.writeHead(answer.status, { 'content-type': 'application/json' });
			response.end(JSON.stringify(answer.json));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	stubs.push(server);
	const { port } = server.address() as AddressInfo;
	return { server, origin: `http://127.0.0.1:${port}`, requests };
}

const accepted = () => ({
	status: 201,
	json: {
		nodeId: 'nod_abcdefgh2345',
		linkUrl: 'wss://link.example.edu/link/nod_abcdefgh2345',
		dashboardPublicKey: DASHBOARD_KEY
	}
});

function deps(box: Box, over: Record<string, unknown> = {}) {
	return {
		ctx: { ...box.ctx, fetch: globalThis.fetch.bind(globalThis) },
		config: box.config,
		state: box.state,
		secrets: box.secrets,
		resolve: publicDns,
		arch: 'arm64',
		...over
	};
}

describe('claim', () => {
	it('claims against a control plane and pins what it answers', async () => {
		const plane = await control(accepted);
		const box = newBox();
		const record = await claim(deps(box), `${plane.origin}/p#${TOKEN}`);
		expect(record).toMatchObject({
			nodeId: 'nod_abcdefgh2345',
			linkUrl: 'wss://link.example.edu/link/nod_abcdefgh2345',
			dashboardPublicKey: DASHBOARD_KEY,
			pairedAt: box.clock.now,
			siteIds: {}
		});
		expect(new PairStore(box.ctx, STATE).record()).toEqual(record);
	});

	it('sends the token in the body, never in the request line or a header', async () => {
		const plane = await control(accepted);
		const box = newBox();
		await claim(deps(box), `${plane.origin}/p#${TOKEN}`);
		const [request] = plane.requests;
		expect(request!.method).toBe('POST');
		expect(request!.url).toBe(CLAIM_PATH);
		expect(JSON.stringify(request!.headers)).not.toContain(TOKEN);
		expect(JSON.parse(request!.body).claimToken).toBe(TOKEN);
		expect(request!.headers[CONTRACT_HEADER.toLowerCase()]).toBe('fleet-link=1.0-1.0');
	});

	it('sends exactly the contract host facts and the public key, nothing else', async () => {
		const plane = await control(accepted);
		const box = newBox();
		await claim(deps(box), `${plane.origin}/p#${TOKEN}`);
		const body = JSON.parse(plane.requests[0]!.body) as Record<string, any>;
		expect(Object.keys(body).sort()).toEqual(['claimToken', 'hostFacts', 'nodePublicKey']);
		expect(Object.keys(body.hostFacts).sort()).toEqual([
			'arch',
			'bastionVersion',
			'mode',
			'os',
			'workerdVersion'
		]);
		expect(body.hostFacts).toMatchObject({ os: 'linux', arch: 'arm64', mode: 'solo' });
		expect(body.nodePublicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it('sends the host name only when the operator allows it', async () => {
		const plane = await control(accepted);
		const box = newBox({
			pairing: {
				sendHostname: true,
				hashNames: false,
				commands: {
					safe: 'queue',
					rebuild: 'queue',
					stateful: 'queue',
					destructive: 'queue'
				}
			}
		});
		await claim(deps(box, { hostname: 'box-7.example.edu' }), `${plane.origin}/p#${TOKEN}`);
		expect(JSON.parse(plane.requests[0]!.body).hostFacts.hostname).toBe('box-7.example.edu');

		const quiet = await control(accepted);
		const other = newBox();
		await claim(deps(other, { hostname: 'box-7.example.edu' }), `${quiet.origin}/p#${TOKEN}`);
		expect(JSON.parse(quiet.requests[0]!.body).hostFacts).not.toHaveProperty('hostname');
	});

	it('keeps the node key in the secrets store at mode 0600, and out of the config, the record and the audit log', async () => {
		const plane = await control(accepted);
		const box = newBox();
		await claim(deps(box), `${plane.origin}/p#${TOKEN}`);
		const seed = await box.secrets.get(NODE_KEY_SECRET);
		expect(seed).not.toBeNull();
		expect(fromBase64Url(seed!)).toHaveLength(32);
		expect(box.files.mode(`${STATE}/secrets/secrets.age`)).toBe(0o600);
		expect(box.files.mode(`${STATE}/pair/pairing.json`)).toBe(0o600);
		expect(JSON.stringify(box.config)).not.toContain(seed!);
		for (const path of ['pair/pairing.json', 'audit.ndjson']) {
			const text = box.files.readText(`${STATE}/${path}`);
			expect(text).not.toContain(seed!);
			expect(text).not.toContain(TOKEN);
		}
		expect(JSON.stringify(box.io.stderr)).not.toContain(TOKEN);
	});

	it('writes an audit event for the claim with no secret in it', async () => {
		const plane = await control(accepted);
		const box = newBox();
		await claim(deps(box), `${plane.origin}/p#${TOKEN}`);
		const [entry] = new AuditLog(box.ctx, `${STATE}/audit.ndjson`, box.config.audit).read();
		expect(entry).toMatchObject({ event: 'pair.claimed', principal: 'operator' });
		expect(entry!.detail).toEqual({ nodeId: 'nod_abcdefgh2345', origin: plane.origin });
	});

	it.each([
		[404, { code: 'invalid_token' }, 'does not know that claim token'],
		[409, { code: 'conflict', details: { reason: 'expired' } }, 'expired'],
		[409, { code: 'conflict', details: { reason: 'already_claimed' } }, 'already used'],
		[409, { code: 'conflict', details: { reason: 'revoked' } }, 'cancelled'],
		[426, { code: 'contract_unsupported' }, 'update bastion'],
		[400, {}, 'refused the claim (400)']
	])('maps a %i answer to a refusal and leaves no key behind', async (status, json, words) => {
		const plane = await control(() => ({ status, json }));
		const box = newBox();
		const error = await claim(deps(box), `${plane.origin}/p#${TOKEN}`).catch(
			(e) => e as BastionError
		);
		expect(error).toBeInstanceOf(BastionError);
		expect((error as BastionError).code).toBe('pairing-refused');
		expect((error as BastionError).message).toContain(words);
		expect(await box.secrets.get(NODE_KEY_SECRET)).toBeNull();
		expect(new PairStore(box.ctx, STATE).record()).toBeNull();
	});

	it('calls a server error unreachable and retryable', async () => {
		const plane = await control(() => ({ status: 503, json: {} }));
		const box = newBox();
		const error = (await claim(deps(box), `${plane.origin}/p#${TOKEN}`).catch(
			(e) => e
		)) as BastionError;
		expect(error.code).toBe('pairing-unreachable');
		expect(error.retryable).toBe(true);
	});

	it('calls a connection failure unreachable and removes the key', async () => {
		const box = newBox();
		const error = (await claim(
			deps(box, {
				ctx: { ...box.ctx, fetch: () => Promise.reject(new Error('connect ECONNREFUSED')) }
			}),
			`https://dash.example.edu/p#${TOKEN}`
		).catch((e) => e)) as BastionError;
		expect(error.code).toBe('pairing-unreachable');
		expect(error.message).not.toContain(TOKEN);
		expect(await box.secrets.get(NODE_KEY_SECRET)).toBeNull();
	});

	it('refuses a reply that is not the claim response', async () => {
		const plane = await control(() => ({ status: 201, json: { nodeId: 'wrong' } }));
		const box = newBox();
		const error = (await claim(deps(box), `${plane.origin}/p#${TOKEN}`).catch(
			(e) => e
		)) as BastionError;
		expect(error.message).toContain('does not understand');
		expect(await box.secrets.get(NODE_KEY_SECRET)).toBeNull();
	});

	it('refuses a link address that is plaintext or inside the box network, and removes the key', async () => {
		for (const linkUrl of [
			'ws://link.example.edu/link/nod_abcdefgh2345',
			'wss://10.0.0.5/link/nod_abcdefgh2345'
		]) {
			const plane = await control(() => ({
				status: 201,
				json: { nodeId: 'nod_abcdefgh2345', linkUrl, dashboardPublicKey: DASHBOARD_KEY }
			}));
			const box = newBox();
			const error = (await claim(deps(box), `${plane.origin}/p#${TOKEN}`).catch(
				(e) => e
			)) as BastionError;
			expect(error).toBeInstanceOf(BastionError);
			expect(await box.secrets.get(NODE_KEY_SECRET)).toBeNull();
			expect(new PairStore(box.ctx, STATE).record()).toBeNull();
		}
	});

	it('refuses a control plane the box egress rules block, before any request', async () => {
		const box = newBox();
		let requests = 0;
		const ctx = {
			...box.ctx,
			fetch: () => {
				requests += 1;
				return Promise.reject(new Error('no'));
			}
		};
		for (const address of [
			`https://10.1.2.3/p#${TOKEN}`,
			`https://169.254.169.254/p#${TOKEN}`,
			`https://[fd00::1]/p#${TOKEN}`
		]) {
			const error = (await claim(deps(box, { ctx }), address).catch(
				(e) => e
			)) as BastionError;
			expect(error.message).toContain('network');
		}
		const named = (await claim(
			deps(box, { ctx, resolve: async () => ['192.168.1.9'] }),
			`https://dash.example.edu/p#${TOKEN}`
		).catch((e) => e)) as BastionError;
		expect(named.message).toContain('192.168.1.9');
		expect(requests).toBe(0);
	});

	it('refuses to claim twice and names the command that clears it', async () => {
		const plane = await control(accepted);
		const box = newBox();
		await claim(deps(box), `${plane.origin}/p#${TOKEN}`);
		const error = (await claim(deps(box), `${plane.origin}/p#${TOKEN}`).catch(
			(e) => e
		)) as BastionError;
		expect(error.message).toContain('already paired as nod_abcdefgh2345');
		expect(error.next).toBe('bastion unpair');
		expect(plane.requests).toHaveLength(1);
	});

	it('refuses to start when the secrets driver cannot hold a key', async () => {
		const plane = await control(accepted);
		const box = newBox();
		const { envSecrets } = await import('../../../src/secrets/store');
		const error = (await claim(
			deps(box, { secrets: envSecrets(box.ctx) }),
			`${plane.origin}/p#${TOKEN}`
		).catch((e) => e)) as BastionError;
		expect(error.code).toBe('driver-refused');
		expect(plane.requests).toHaveLength(0);
	});
});
