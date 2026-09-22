import { describe, expect, it } from 'vitest';
import { forward, forwardTarget, isDialable, placementFor } from '../../../src/cluster/forward';
import type { Placement } from '../../../src/cluster/placement';
import { HOP_HEADER } from '../../../src/cluster/protocol';
import type { ClusterNode } from '../../../src/cluster/registry';
import { defaultContext, type Context } from '../../../src/context';

/**
 * Which node answers, and what happens when it is not this one.
 *
 * The decision itself is `chooseNode`, which mirrors the worker's own pins and has its own spec.
 * What is new here is the loop guard and the dialling: two nodes that disagree about placement
 * would otherwise forward to each other until a client gives up.
 */
const NODES: ClusterNode[] = [
	{
		id: 'node-a',
		address: 'node-a:8787',
		serves: 'node-a:80',
		labels: {},
		state: 'ready',
		lastSeenAt: 0,
		capacity: null,
		auditHead: null
	},
	{
		id: 'node-b',
		address: 'node-b:8787',
		serves: 'node-b:80',
		labels: {},
		state: 'ready',
		lastSeenAt: 0,
		capacity: null,
		auditHead: null
	}
];

const PLACEMENT: Placement[] = [
	{ site: 'www.example.edu', tenant: 'acme', primary: 'node-a', replicas: ['node-b'] }
];

const ask = (path = '/serve', init: RequestInit = {}) =>
	new Request(`http://www.example.edu${path}`, init);

const at = (localNode: string, request = ask(), placement = PLACEMENT) =>
	forwardTarget({ request, site: 'www.example.edu', localNode, placement, nodes: NODES });

describe('placementFor', () => {
	it('finds a site and answers null for one nothing placed', () => {
		expect(placementFor(PLACEMENT, 'www.example.edu')?.primary).toBe('node-a');
		expect(placementFor(PLACEMENT, 'other.example.edu')).toBe(null);
	});
});

describe('forwardTarget', () => {
	it('answers locally on the primary', () => {
		expect(at('node-a')).toBe(null);
	});

	it('answers locally on a replica for a spreadable read', () => {
		expect(at('node-b')).toBe(null);
	});

	it('forwards a write from a replica to the primary', () => {
		const target = at('node-b', ask('/serve', { method: 'POST' }));
		expect(target?.node.id).toBe('node-a');
		expect(target?.decision.reason).toContain('write');
	});

	it('forwards a route that is not the serving path to the primary', () => {
		expect(at('node-b', ask('/admin'))?.node.id).toBe('node-a');
	});

	it('forwards from a node holding neither role', () => {
		expect(at('node-c')?.node.id).toBe('node-a');
	});

	/** the guard: a request that was already forwarded is answered here or refused, never again */
	it('never forwards a request that carries the hop header', () => {
		const carried = ask('/admin', { headers: { [HOP_HEADER]: 'node-b' } });
		expect(at('node-c', carried)).toBe(null);
	});

	it('answers locally when nothing placed this site', () => {
		expect(at('node-c', ask(), [])).toBe(null);
	});

	it('answers locally when the chosen node is not in the registry', () => {
		const orphaned: Placement[] = [
			{ site: 'www.example.edu', tenant: 'acme', primary: 'node-z', replicas: [] }
		];
		expect(at('node-c', ask(), orphaned)).toBe(null);
	});

	it('does not forward to a node that has left', () => {
		const left = NODES.map((node) =>
			node.id === 'node-a' ? { ...node, state: 'left' as const } : node
		);
		expect(
			forwardTarget({
				request: ask('/admin'),
				site: 'www.example.edu',
				localNode: 'node-b',
				placement: PLACEMENT,
				nodes: left
			})
		).toBe(null);
	});
});

describe('forward', () => {
	function dialling(answer: Response | Error) {
		const seen: { url: string; headers: Headers; method: string }[] = [];
		const ctx: Context = {
			...defaultContext(),
			fetch: ((url: string, init: RequestInit) => {
				seen.push({
					url,
					headers: new Headers(init.headers),
					method: init.method ?? 'GET'
				});
				return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
			}) as Context['fetch']
		};
		return { ctx, seen };
	}

	const target = {
		decision: { node: 'node-a', role: 'primary' as const, reason: '' },
		node: NODES[0] as ClusterNode
	};

	it('dials the serving address rather than the management one', async () => {
		const { ctx, seen } = dialling(new Response('served'));
		await forward(ctx, target, ask('/serve?page=2'), 'node-b');
		expect(seen[0]?.url).toBe('http://node-a:80/serve?page=2');
	});

	it('forwards the host unchanged, which decides the session cookie name', async () => {
		const { ctx, seen } = dialling(new Response('served'));
		await forward(ctx, target, ask(), 'node-b');
		expect(seen[0]?.headers.get('host')).toBe('www.example.edu');
	});

	it('stamps the hop header with the node it came from', async () => {
		const { ctx, seen } = dialling(new Response('served'));
		await forward(ctx, target, ask(), 'node-b');
		expect(seen[0]?.headers.get(HOP_HEADER)).toBe('node-b');
	});

	it('says which node answered, so a trace is readable', async () => {
		const { ctx } = dialling(new Response('served'));
		const response = await forward(ctx, target, ask(), 'node-b');
		expect(response.headers.get('x-bastion-forwarded-to')).toBe('node-a');
		expect(await response.text()).toBe('served');
	});

	it('names the node that did not answer rather than failing bare', async () => {
		const { ctx } = dialling(new Error('connect ECONNREFUSED'));
		const response = await forward(ctx, target, ask(), 'node-b');
		expect(response.status).toBe(502);
		expect(await response.text()).toContain('node-a did not answer');
	});

	/**
	 * The defect that made a two-node cluster look like it was working.
	 *
	 * Both nodes advertised their bind address, `0.0.0.0`. Rewriting that to loopback made every
	 * forward dial the forwarding node, which answered it locally and returned 200: reads, writes
	 * and unspreadable routes all succeeded, from the wrong box.
	 */
	it('refuses a wildcard rather than rewriting it to loopback', async () => {
		const { ctx, seen } = dialling(new Response('served'));
		const wildcard = { ...target, node: { ...NODES[0], serves: '0.0.0.0:80' } as ClusterNode };
		const response = await forward(ctx, wildcard, ask(), 'node-b');
		expect(response.status).toBe(502);
		expect(await response.text()).toContain('no other node can dial');
		expect(seen).toHaveLength(0);
	});

	it('names what makes an address dialable', () => {
		expect(isDialable('node-a:8080')).toBe(true);
		expect(isDialable('10.0.0.4:8080')).toBe(true);
		expect(isDialable('http://node-a:8080')).toBe(true);
		expect(isDialable('0.0.0.0:8080')).toBe(false);
		expect(isDialable('[::]:8080')).toBe(false);
		expect(isDialable('')).toBe(false);
	});
});
