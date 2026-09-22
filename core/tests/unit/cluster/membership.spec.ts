import { describe, expect, it } from 'vitest';
import {
	MembershipStore,
	heartbeat,
	join,
	reportOf,
	type Membership
} from '../../../src/cluster/membership';
import { CLUSTER_PATHS, CLUSTER_PROTOCOL } from '../../../src/cluster/protocol';
import { defaultConfig } from '../../../src/config/defaults';
import { defaultContext, type Context } from '../../../src/context';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';

/**
 * The child's half: it dials out, and what it keeps survives the control node going away.
 *
 * The partition case is the one that matters. A node that stops serving because it cannot reach
 * the control node has turned a control-plane outage into a site outage, which is the opposite of
 * what a cluster is for.
 */
const STATE = '/var/lib/bastion';

function child(answers: Record<string, { status: number; body: unknown }>) {
	const files = memoryFiles({});
	const calls: { url: string; body: unknown; authorization: string | null }[] = [];
	let now = 1000;
	const ctx: Context = {
		...defaultContext(),
		files,
		io: memoryIo(),
		now: () => now,
		fetch: ((url: string, init: RequestInit) => {
			calls.push({
				url,
				body: JSON.parse(String(init.body)),
				authorization: new Headers(init.headers).get('authorization')
			});
			// the host matters as well as the path: a node pointed at an address nothing answers
			// on must fail, and a stub keyed on the path alone answers everywhere
			const parsed = new URL(url);
			const answer = parsed.host === 'node-a:8787' ? answers[parsed.pathname] : undefined;
			if (answer === undefined) return Promise.reject(new Error('connect ECONNREFUSED'));
			return Promise.resolve(
				new Response(JSON.stringify(answer.body), { status: answer.status })
			);
		}) as Context['fetch']
	};
	return { ctx, files, calls, tick: (ms: number) => (now += ms) };
}

const JOINED = {
	ok: true,
	result: {
		protocol: CLUSTER_PROTOCOL,
		credential: 'bsn_secret',
		cluster: { mode: 'solo', residency: 'evict', tenants: ['acme'] },
		placement: [{ site: 'www.example.edu', tenant: 'acme', primary: 'node-b', replicas: [] }],
		heartbeatMs: 10_000
	}
};

const report = reportOf(
	{
		...defaultConfig(),
		cluster: { role: 'child', node: { id: 'node-b', labels: { rack: 'b2' } } }
	},
	{ sites: 40, memoryBytes: 1024 }
);

describe('reportOf', () => {
	/**
	 * The host is advertised and only the ports are local.
	 *
	 * Reporting the bind address whole is what made a two-node cluster look like it worked: a node
	 * binding `0.0.0.0` advertised `0.0.0.0`, and every peer that tried to dial it reached itself.
	 */
	it('advertises a host peers can dial, with the ports this node binds', () => {
		expect(report.address).toBe('node-b:8787');
		expect(report.serves).toBe('node-b:80');
	});

	it('prefers an explicit advertise over the node id', () => {
		const explicit = reportOf(
			{
				...defaultConfig(),
				cluster: {
					role: 'child',
					node: { id: 'node-b', advertise: '10.0.0.4', labels: {} }
				}
			},
			null
		);
		expect(explicit.address).toBe('10.0.0.4:8787');
		expect(explicit.serves).toBe('10.0.0.4:80');
	});

	it('never advertises the wildcard it binds', () => {
		const wildcard = reportOf(
			{
				...defaultConfig(),
				listeners: {
					...defaultConfig().listeners,
					http: { address: '0.0.0.0:8080' },
					management: { address: '0.0.0.0:8787' }
				},
				cluster: { role: 'child', node: { id: 'node-b', labels: {} } }
			},
			null
		);
		expect(wildcard.address).not.toContain('0.0.0.0');
		expect(wildcard.serves).toBe('node-b:8080');
	});

	it('carries the labels placement uses for rack diversity', () => {
		expect(report.labels).toEqual({ rack: 'b2' });
	});
});

describe('join', () => {
	it('dials the control node and keeps what it gets', async () => {
		const { ctx, calls } = child({ [CLUSTER_PATHS.join]: { status: 200, body: JOINED } });
		const membership = await join(ctx, {
			control: 'node-a:8787',
			token: 'bsj_token',
			report,
			state: STATE
		});
		expect(calls[0]?.url).toBe(`http://node-a:8787${CLUSTER_PATHS.join}`);
		expect(membership.credential).toBe('bsn_secret');
		expect(new MembershipStore(ctx, STATE).read()?.node).toBe('node-b');
	});

	it('takes an address already carrying a scheme', async () => {
		const { ctx, calls } = child({ [CLUSTER_PATHS.join]: { status: 200, body: JOINED } });
		await join(ctx, {
			control: 'https://node-a:8787/',
			token: 'bsj_token',
			report,
			state: STATE
		});
		expect(calls[0]?.url).toBe(`https://node-a:8787${CLUSTER_PATHS.join}`);
	});

	it('writes nothing when the control node refuses', async () => {
		const { ctx } = child({
			[CLUSTER_PATHS.join]: {
				status: 401,
				body: { ok: false, error: { code: 'x', message: 'that join token is not valid' } }
			}
		});
		await expect(
			join(ctx, { control: 'node-a:8787', token: 'bad', report, state: STATE })
		).rejects.toThrow('that join token is not valid');
		expect(new MembershipStore(ctx, STATE).read()).toBe(null);
	});

	it('says which node it could not reach rather than failing bare', async () => {
		const { ctx } = child({});
		await expect(
			join(ctx, { control: 'node-a:8787', token: 'bsj_token', report, state: STATE })
		).rejects.toThrow(/could not reach the control node at http:\/\/node-a:8787/);
	});
});

describe('heartbeat', () => {
	const joined = async () => {
		const rig = child({
			[CLUSTER_PATHS.join]: { status: 200, body: JOINED },
			[CLUSTER_PATHS.heartbeat]: {
				status: 200,
				body: {
					ok: true,
					result: {
						protocol: CLUSTER_PROTOCOL,
						cluster: { mode: 'solo', residency: 'evict', tenants: ['acme', 'beta'] },
						placement: [
							{
								site: 'www.example.edu',
								tenant: 'acme',
								primary: 'node-b',
								replicas: ['node-a']
							}
						],
						nodes: [{ id: 'node-a' }, { id: 'node-b' }]
					}
				}
			}
		});
		await join(rig.ctx, { control: 'node-a:8787', token: 'bsj_token', report, state: STATE });
		return rig;
	};

	it('presents the credential rather than the join token', async () => {
		const { ctx, calls } = await joined();
		await heartbeat(ctx, STATE);
		expect(calls[1]?.authorization).toBe('Bearer bsn_secret');
	});

	it('brings back the placement and the node list, and records them', async () => {
		const { ctx } = await joined();
		const answer = await heartbeat(ctx, STATE);
		expect(answer.reached).toBe(true);
		expect(answer.membership?.placement[0]?.replicas).toEqual(['node-a']);
		expect(new MembershipStore(ctx, STATE).read()?.nodes).toHaveLength(2);
	});

	it('moves the sync clock, which is what staleness is measured from', async () => {
		const { ctx, tick } = await joined();
		tick(5_000);
		await heartbeat(ctx, STATE);
		expect(new MembershipStore(ctx, STATE).read()?.lastSyncedAt).toBe(6_000);
	});

	/** a control-plane outage must not become a site outage */
	it('keeps what it holds when the control node cannot be reached', async () => {
		const { ctx, files } = await joined();
		const held = new MembershipStore(ctx, STATE).read() as Membership;
		files.writeText(`${STATE}/cluster.json`, JSON.stringify({ ...held, control: 'gone:9999' }));

		const answer = await heartbeat(ctx, STATE);
		expect(answer.reached).toBe(false);
		expect(answer.reason).toContain('could not reach');
		expect(answer.membership?.placement).toHaveLength(1);
		expect(new MembershipStore(ctx, STATE).read()?.placement).toHaveLength(1);
	});

	it('says so plainly on a node that never joined', async () => {
		const { ctx } = child({});
		const answer = await heartbeat(ctx, STATE);
		expect(answer.reached).toBe(false);
		expect(answer.reason).toContain('has not joined');
	});
});

describe('MembershipStore', () => {
	it('answers null rather than throwing on a truncated file', () => {
		const { ctx, files } = child({});
		files.writeText(`${STATE}/cluster.json`, '{ not json');
		expect(new MembershipStore(ctx, STATE).read()).toBe(null);
	});

	it('clears, which is what leaving a cluster does', async () => {
		const { ctx } = child({ [CLUSTER_PATHS.join]: { status: 200, body: JOINED } });
		await join(ctx, { control: 'node-a:8787', token: 'bsj_token', report, state: STATE });
		const store = new MembershipStore(ctx, STATE);
		store.clear();
		expect(store.read()).toBe(null);
	});
});
