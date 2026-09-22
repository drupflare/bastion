/**
 * The control node's half of the wire.
 *
 * Answers the endpoints in {@link ./protocol}, and nothing else: membership and placement. Serving
 * traffic is forwarded node to node over each node's ordinary http listener, so there is one
 * request shape for a site rather than a second protocol that has to stay in step with the first.
 *
 * Every call except `join` presents a node credential. A credential resolves to a NODE and never
 * to a principal, so nothing here can reach the operator authz table by holding the wrong secret.
 */

import type { BastionConfig } from '../config/types';
import type { Context } from '../context';
import { NodeCredentials, nodeBearer } from './credentials';
import type { Placement } from './placement';
import {
	CLUSTER_PROTOCOL,
	clusterPathOf,
	type ClusterEnvelope,
	type ClusterSettings,
	type HeartbeatAnswer,
	type HeartbeatRequest,
	type JoinAnswer,
	type JoinRequest,
	type NodesAnswer,
	type ReplicaRequest
} from './protocol';
import { HEARTBEAT_MS, NodeRegistry } from './registry';

export interface ControlDeps {
	config: BastionConfig;
	registry: NodeRegistry;
	credentials: NodeCredentials;
	/** the placement table this cluster is running, read and written by the caller */
	placement(): Placement[];
	/**
	 * Drives this node's own site `/replica` route on another node's behalf.
	 *
	 * The front door refuses `/replica` along with the rest of the diagnostic set, outside the
	 * site's control, and that refusal stays: this is an authenticated bypass for a peer holding a
	 * node credential, not a hole in the deny list. Absent on a node that serves nothing.
	 */
	replica?(request: ReplicaRequest, from: string): Promise<{ ok: boolean; detail: string }>;
	/** records who did what, the same audit sink the management API writes to */
	audit?(event: { event: string; principal: string; detail: unknown }): void;
}

function answer<T>(body: ClusterEnvelope<T>, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' }
	});
}

const refuse = (code: string, message: string, status: number): Response =>
	answer({ ok: false, error: { code, message } }, status);

export function settingsOf(config: BastionConfig): ClusterSettings {
	return {
		mode: config.mode,
		residency: config.runtime.residency,
		tenants: config.tenants.map((tenant) => tenant.name)
	};
}

/**
 * Handles one cluster request, or returns null when the path is not one of ours.
 *
 * Null rather than a 404 so the management listener can try its own routes next; the cluster
 * prefix is a different surface on the same port rather than a different server.
 */
export async function handleCluster(
	ctx: Context,
	request: Request,
	deps: ControlDeps
): Promise<Response | null> {
	const url = new URL(request.url);
	const which = clusterPathOf(url.pathname);
	if (which === null) return null;

	// membership is the control node's business; a replica call is answered by whichever node
	// holds the site, which is usually not the control node
	if (which !== 'replica' && deps.config.cluster?.role !== 'control') {
		return refuse(
			'capability-refused',
			'this node is not the control node; children dial out and it never dials in',
			409
		);
	}

	let body: Record<string, unknown> = {};
	if (request.method === 'POST') {
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return refuse('usage', 'the request body is not json', 400);
		}
	}

	const spoken = Number(body.protocol ?? CLUSTER_PROTOCOL);
	if (spoken !== CLUSTER_PROTOCOL) {
		return refuse(
			'usage',
			`this node speaks cluster protocol ${CLUSTER_PROTOCOL} and was offered ${spoken}`,
			409
		);
	}

	if (which === 'join') {
		const join = body as unknown as JoinRequest;
		if (join.node?.id === undefined || join.token === undefined) {
			return refuse('usage', 'a join needs a token and a node', 400);
		}
		const credential = deps.credentials.redeem(join.token, join.node.id);
		if (credential === null) {
			// one message for a wrong token, an expired one and a spent one
			return refuse('capability-refused', 'that join token is not valid', 401);
		}

		deps.registry.join(
			join.node.id,
			join.node.address,
			join.node.labels ?? {},
			join.node.serves
		);
		if (join.node.capacity !== null || join.node.auditHead !== null) {
			deps.registry.heartbeat(join.node.id, {
				...(join.node.capacity === null ? {} : { capacity: join.node.capacity }),
				...(join.node.auditHead === null ? {} : { auditHead: join.node.auditHead })
			});
		}
		deps.audit?.({ event: 'cluster.join', principal: join.node.id, detail: join.node });

		const result: JoinAnswer = {
			protocol: CLUSTER_PROTOCOL,
			credential,
			cluster: settingsOf(deps.config),
			placement: deps.placement(),
			heartbeatMs: HEARTBEAT_MS
		};
		return answer({ ok: true, result }, 200);
	}

	const node = deps.credentials.verify(nodeBearer(request));
	if (node === null) return refuse('unauthenticated', 'no node credential', 401);

	if (which === 'heartbeat') {
		const beat = body as unknown as HeartbeatRequest;
		// the credential names the node, never the body: a child could otherwise heartbeat as
		// another node and take its placement with it
		deps.registry.heartbeat(node, {
			...(beat.node?.capacity === undefined ? {} : { capacity: beat.node.capacity }),
			...(beat.node?.auditHead === undefined ? {} : { auditHead: beat.node.auditHead })
		});
		deps.registry.sweep();
		const result: HeartbeatAnswer = {
			protocol: CLUSTER_PROTOCOL,
			cluster: settingsOf(deps.config),
			placement: deps.placement(),
			nodes: deps.registry.list()
		};
		return answer({ ok: true, result }, 200);
	}

	if (which === 'nodes') {
		const result: NodesAnswer = { protocol: CLUSTER_PROTOCOL, nodes: deps.registry.list() };
		return answer({ ok: true, result }, 200);
	}

	if (which === 'replica') {
		if (deps.replica === undefined) {
			return refuse('not-implemented', 'this node serves no sites to replicate', 501);
		}
		const ask = body as unknown as ReplicaRequest;
		if (typeof ask.site !== 'string' || typeof ask.action !== 'string') {
			return refuse('usage', 'a replica call needs a site and an action', 400);
		}
		const result = await deps.replica(ask, node);
		return answer({ ok: result.ok, result }, result.ok ? 200 : 502);
	}

	return refuse('not-implemented', `${url.pathname} has no handler on the control node`, 501);
}
