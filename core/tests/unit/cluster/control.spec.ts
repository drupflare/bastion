import { describe, expect, it } from 'vitest';
import { handleCluster, settingsOf } from '../../../src/cluster/control';
import { NodeCredentials } from '../../../src/cluster/credentials';
import type { Placement } from '../../../src/cluster/placement';
import { CLUSTER_PATHS, CLUSTER_PROTOCOL } from '../../../src/cluster/protocol';
import { NodeRegistry } from '../../../src/cluster/registry';
import { defaultConfig } from '../../../src/config/defaults';
import type { BastionConfig } from '../../../src/config/types';
import { defaultContext } from '../../../src/context';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';

/**
 * The control node's half of the wire.
 *
 * The rule every test here defends: a child names itself in the body, and the body is never
 * believed. The CREDENTIAL says which node is calling, so a compromised child cannot heartbeat as
 * another node and take its placement with it.
 */
const STATE = '/var/lib/bastion';
const ORIGIN = 'http://control:8787';

function harness(over: Partial<BastionConfig> = {}) {
	const files = memoryFiles({});
	const ctx = { ...defaultContext(), files, io: memoryIo(), now: () => 1000 };
	const config: BastionConfig = {
		...defaultConfig(),
		state: STATE,
		cluster: { role: 'control', node: { id: 'node-a', labels: {} } },
		...over
	};
	const placement: Placement[] = [
		{ site: 'www.example.edu', tenant: 'acme', primary: 'node-a', replicas: ['node-b'] }
	];
	const credentials = new NodeCredentials(ctx, STATE);
	const deps = {
		config,
		registry: new NodeRegistry(ctx, STATE),
		credentials,
		placement: () => placement
	};
	const call = async (path: string, body?: unknown, credential?: string) =>
		handleCluster(
			ctx,
			new Request(`${ORIGIN}${path}`, {
				method: body === undefined ? 'GET' : 'POST',
				...(credential === undefined
					? {}
					: { headers: { authorization: `Bearer ${credential}` } }),
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			}),
			deps
		);
	return { ctx, credentials, deps, call, config };
}

const node = (id: string) => ({
	id,
	address: `${id}:8787`,
	serves: `${id}:80`,
	labels: {},
	capacity: { sites: 40, memoryBytes: 4 * 1024 ** 3 },
	auditHead: null
});

const body = async (response: Response | null) =>
	(await (response as Response).json()) as {
		ok: boolean;
		result?: never;
		error?: { message: string };
	};

describe('handleCluster', () => {
	it('leaves a path that is not one of ours to the caller', async () => {
		expect(await harness().call('/api/status')).toBe(null);
	});

	it('refuses everything on a node that is not the control node', async () => {
		const { call } = harness({
			cluster: { role: 'child', node: { id: 'node-b', labels: {} } }
		});
		const response = (await call(CLUSTER_PATHS.nodes)) as Response;
		expect(response.status).toBe(409);
		expect((await body(response)).error?.message).toContain('never dials in');
	});

	it('refuses a protocol it does not speak, and says which it does', async () => {
		const { call, credentials } = harness();
		const token = credentials.mintJoinToken();
		const response = (await call(CLUSTER_PATHS.join, {
			protocol: CLUSTER_PROTOCOL + 1,
			token,
			node: node('node-b')
		})) as Response;
		expect(response.status).toBe(409);
		expect((await body(response)).error?.message).toContain(
			`speaks cluster protocol ${CLUSTER_PROTOCOL}`
		);
	});

	it('refuses a body that is not json', async () => {
		const { deps, ctx } = harness();
		const response = (await handleCluster(
			ctx,
			new Request(`${ORIGIN}${CLUSTER_PATHS.join}`, { method: 'POST', body: 'not json' }),
			deps
		)) as Response;
		expect(response.status).toBe(400);
	});
});

describe('join', () => {
	it('gives a child its credential, the cluster settings and the placement', async () => {
		const { call, credentials } = harness();
		const token = credentials.mintJoinToken();
		const response = (await call(CLUSTER_PATHS.join, {
			protocol: CLUSTER_PROTOCOL,
			token,
			node: node('node-b')
		})) as Response;
		expect(response.status).toBe(200);
		const answer = (await response.json()) as {
			result: { credential: string; cluster: { mode: string }; placement: unknown[] };
		};
		expect(answer.result.credential.startsWith('bsn_')).toBe(true);
		expect(answer.result.cluster.mode).toBe('solo');
		expect(answer.result.placement).toHaveLength(1);
	});

	it('registers the node with the address it serves from, not only its management one', async () => {
		const { call, credentials, deps } = harness();
		await call(CLUSTER_PATHS.join, {
			protocol: CLUSTER_PROTOCOL,
			token: credentials.mintJoinToken(),
			node: node('node-b')
		});
		expect(deps.registry.get('node-b')?.serves).toBe('node-b:80');
		expect(deps.registry.get('node-b')?.capacity?.sites).toBe(40);
	});

	it('refuses a wrong token, a spent one and a missing one alike', async () => {
		const { call, credentials } = harness();
		const token = credentials.mintJoinToken();
		const join = (t: string) =>
			call(CLUSTER_PATHS.join, {
				protocol: CLUSTER_PROTOCOL,
				token: t,
				node: node('node-b')
			});

		expect(((await join('bsj_wrong')) as Response).status).toBe(401);
		expect(((await join(token)) as Response).status).toBe(200);
		expect(((await join(token)) as Response).status).toBe(401);
	});

	it('refuses a join naming no node', async () => {
		const { call, credentials } = harness();
		const response = (await call(CLUSTER_PATHS.join, {
			protocol: CLUSTER_PROTOCOL,
			token: credentials.mintJoinToken()
		})) as Response;
		expect(response.status).toBe(400);
	});
});

describe('heartbeat', () => {
	const joined = async () => {
		const h = harness();
		const answer = (await h.call(CLUSTER_PATHS.join, {
			protocol: CLUSTER_PROTOCOL,
			token: h.credentials.mintJoinToken(),
			node: node('node-b')
		})) as Response;
		const credential = ((await answer.json()) as { result: { credential: string } }).result
			.credential;
		return { ...h, credential };
	};

	it('needs a node credential', async () => {
		const { call } = await joined();
		expect(
			((await call(CLUSTER_PATHS.heartbeat, { protocol: CLUSTER_PROTOCOL })) as Response)
				.status
		).toBe(401);
	});

	it('answers with the placement and the node list', async () => {
		const { call, credential } = await joined();
		const response = (await call(
			CLUSTER_PATHS.heartbeat,
			{ protocol: CLUSTER_PROTOCOL, node: { id: 'node-b', capacity: null, auditHead: null } },
			credential
		)) as Response;
		const answer = (await response.json()) as {
			result: { placement: unknown[]; nodes: { id: string }[] };
		};
		expect(answer.result.placement).toHaveLength(1);
		expect(answer.result.nodes.map((n) => n.id)).toContain('node-b');
	});

	/** the body names a node; the credential decides which one it is */
	it('records against the credential rather than the id the body claims', async () => {
		const { call, credential, deps } = await joined();
		deps.registry.join('node-c', 'node-c:8787', {}, 'node-c:80');
		const before = deps.registry.get('node-c')?.capacity ?? null;

		await call(
			CLUSTER_PATHS.heartbeat,
			{
				protocol: CLUSTER_PROTOCOL,
				node: { id: 'node-c', capacity: { sites: 9, memoryBytes: 1 }, auditHead: null }
			},
			credential
		);
		expect(deps.registry.get('node-c')?.capacity).toEqual(before);
		expect(deps.registry.get('node-b')?.capacity).toEqual({ sites: 9, memoryBytes: 1 });
	});

	it('refuses a credential that was revoked', async () => {
		const { call, credential, credentials } = await joined();
		credentials.revoke('node-b');
		const response = (await call(
			CLUSTER_PATHS.heartbeat,
			{ protocol: CLUSTER_PROTOCOL, node: { id: 'node-b' } },
			credential
		)) as Response;
		expect(response.status).toBe(401);
	});
});

describe('settingsOf', () => {
	it('carries only the keys a child may not decide for itself', () => {
		const settings = settingsOf({
			...defaultConfig(),
			tenants: [{ name: 'acme', sites: [] }]
		});
		expect(Object.keys(settings).sort()).toEqual(['mode', 'residency', 'tenants']);
		expect(settings.tenants).toEqual(['acme']);
	});
});
