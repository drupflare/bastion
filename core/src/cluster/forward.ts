/**
 * Sending a request to the node that holds the site.
 *
 * A forward dials the target node's ordinary http listener with the original `Host`, so the
 * receiving node routes it exactly as it would a request from a browser. One request shape rather
 * than two, and the receiving node needs no knowledge that it was forwarded beyond the loop guard.
 *
 * **The `Host` is forwarded unchanged, and that is load bearing rather than incidental.** Drupal
 * derives its session cookie name from the host it sees, so a node that rewrote it would render
 * every visitor anonymous on that node alone, deterministically, with every gate spec still
 * passing. `pool-defect-history.md` records exactly that failure costing weeks.
 */

import type { Context } from '../context';
import type { Placement } from './placement';
import { HOP_HEADER } from './protocol';
import type { ClusterNode } from './registry';
import { chooseNode, mustProxy, type NodeDecision } from './route';

export interface ForwardTarget {
	decision: NodeDecision;
	node: ClusterNode;
}

export function placementFor(placement: Placement[], site: string): Placement | null {
	return placement.find((entry) => entry.site === site) ?? null;
}

/**
 * The node that should answer, or null to answer here.
 *
 * Null covers four cases that are all "serve it locally": no placement for this site, this node is
 * the one chosen, the chosen node is not in the registry, and the request was already forwarded.
 * The last is the loop guard: two nodes disagreeing about placement would otherwise forward to
 * each other until something times out.
 */
export function forwardTarget(input: {
	request: Request;
	site: string;
	localNode: string;
	placement: Placement[];
	nodes: ClusterNode[];
}): ForwardTarget | null {
	if (input.request.headers.get(HOP_HEADER) !== null) return null;

	const held = placementFor(input.placement, input.site);
	if (held === null) return null;

	const decision = chooseNode({
		site: input.site,
		method: input.request.method,
		localNode: input.localNode,
		primaryNode: held.primary,
		replicaNodes: held.replicas,
		pathname: new URL(input.request.url).pathname,
		hasSession: input.request.headers.get('cookie') !== null
	});
	if (!mustProxy(decision, input.localNode)) return null;

	const node = input.nodes.find((entry) => entry.id === decision.node);
	if (node === undefined || node.state === 'left') return null;
	return { decision, node };
}

/**
 * A wildcard is refused rather than rewritten to loopback.
 *
 * Rewriting is what hid the defect: a node that advertised `0.0.0.0` had every peer dial itself,
 * answer locally, and report a healthy cluster. An address no peer can reach is a configuration
 * error and says so.
 */
export function isDialable(address: string): boolean {
	const bare = address.replace(/^https?:\/\//, '');
	// a v6 literal carries its own colons, so the brackets come off before the port does
	const host = bare.startsWith('[')
		? bare.slice(1, bare.indexOf(']'))
		: (bare.split(':')[0] ?? '');
	return host !== '0.0.0.0' && host !== '::' && host !== '';
}

const origin = (address: string): string =>
	address.startsWith('http://') || address.startsWith('https://')
		? address.replace(/\/$/, '')
		: `http://${address}`;

/**
 * Forwards one request and answers with what came back.
 *
 * A node that cannot be reached answers 502 naming the node rather than a bare failure: an
 * operator reading it needs to know WHICH box is unreachable, and the alternative is a request
 * that hangs until a client gives up.
 */
export async function forward(
	ctx: Context,
	target: ForwardTarget,
	request: Request,
	localNode: string
): Promise<Response> {
	const url = new URL(request.url);
	if (!isDialable(target.node.serves)) {
		return new Response(
			`${target.node.id} advertises ${target.node.serves}, which no other node can dial; ` +
				'set `cluster.node.advertise` on it',
			{ status: 502, headers: { 'x-bastion-forwarded-to': target.node.id } }
		);
	}
	const to = `${origin(target.node.serves)}${url.pathname}${url.search}`;
	const headers = new Headers(request.headers);
	// set explicitly rather than copied: `Host` is not in `request.headers` at all, because fetch
	// derives it from the url. Dialling the peer without it would arrive as `Host: node-b:80`, the
	// receiving node would route by that, and the site would not be found
	headers.set('host', url.host);
	headers.set(HOP_HEADER, localNode);

	try {
		const answer = await ctx.fetch(to, {
			method: request.method,
			headers,
			...(request.method === 'GET' || request.method === 'HEAD'
				? {}
				: { body: await request.arrayBuffer() }),
			redirect: 'manual'
		});
		const out = new Headers(answer.headers);
		out.set('x-bastion-forwarded-to', target.node.id);
		return new Response(answer.body, { status: answer.status, headers: out });
	} catch (error) {
		return new Response(
			`${target.node.id} did not answer: ${error instanceof Error ? error.message : String(error)}`,
			{ status: 502, headers: { 'x-bastion-forwarded-to': target.node.id } }
		);
	}
}
