/**
 * A child's half of the wire: it dials out, and nothing dials it.
 *
 * What a child keeps from the exchange is written to `<state>/cluster.json` so the serving path
 * can read the placement table without a network call on every request. A node that cannot reach
 * the control node keeps serving from that file, which is the same offline-first rule the rest of
 * the box follows: a partition must not blind a node to the sites it already holds.
 */

import type { BastionConfig } from '../config/types';
import type { Context } from '../context';
import { BastionError } from '../errors';
import type { Placement } from './placement';
import {
	CLUSTER_PATHS,
	CLUSTER_PROTOCOL,
	type ClusterEnvelope,
	type ClusterSettings,
	type HeartbeatAnswer,
	type JoinAnswer,
	type NodeReport
} from './protocol';
import type { ClusterNode } from './registry';

export const MEMBERSHIP_FILE = 'cluster.json';

export interface Membership {
	protocol: number;
	control: string;
	node: string;
	credential: string;
	cluster: ClusterSettings;
	placement: Placement[];
	nodes: ClusterNode[];
	heartbeatMs: number;
	/** when the control node was last reached; a partition is visible rather than silent */
	lastSyncedAt: number;
}

export class MembershipStore {
	private readonly ctx: Context;
	private readonly path: string;

	constructor(ctx: Context, state: string) {
		this.ctx = ctx;
		this.path = `${state}/${MEMBERSHIP_FILE}`;
	}

	read(): Membership | null {
		if (!this.ctx.files.exists(this.path)) return null;
		try {
			return JSON.parse(this.ctx.files.readText(this.path)) as Membership;
		} catch {
			return null;
		}
	}

	write(membership: Membership): void {
		this.ctx.files.writeText(this.path, JSON.stringify(membership));
		// it carries this node's credential, so it is no more readable than the token file
		this.ctx.files.chmod(this.path, 0o600);
	}

	clear(): void {
		this.ctx.files.remove(this.path);
	}
}

const base = (address: string): string =>
	address.startsWith('http://') || address.startsWith('https://')
		? address.replace(/\/$/, '')
		: `http://${address}`;

async function post<T>(ctx: Context, url: string, body: unknown, credential?: string): Promise<T> {
	let response: Response;
	try {
		response = await ctx.fetch(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(credential === undefined ? {} : { authorization: `Bearer ${credential}` })
			},
			body: JSON.stringify(body)
		});
	} catch (error) {
		throw new BastionError(
			'unreachable',
			`could not reach the control node at ${url}: ${error instanceof Error ? error.message : String(error)}`,
			{ retryable: true }
		);
	}

	const envelope = (await response.json().catch(() => ({ ok: false }))) as ClusterEnvelope<T>;
	if (!response.ok || envelope.ok !== true) {
		throw new BastionError(
			'capability-refused',
			envelope.error?.message ?? `the control node answered ${response.status}`,
			{ retryable: response.status >= 500 }
		);
	}
	return envelope.result as T;
}

/** the port half of a bind address, which is the only half a peer can reuse */
const portOf = (address: string): string => address.slice(address.lastIndexOf(':') + 1);

/**
 * What this node tells the control node about itself.
 *
 * The HOST comes from `advertise` (defaulting to the node id) and the PORTS from the local
 * listeners. Reporting the bind address whole is what made a cluster look like it worked: a node
 * binding `0.0.0.0` advertised `0.0.0.0`, every peer rewrote that to loopback, and every forward
 * went to the forwarding node, which answered it locally.
 */
export function reportOf(config: BastionConfig, capacity: NodeReport['capacity']): NodeReport {
	const id = config.cluster?.node.id ?? 'node';
	const host = config.cluster?.node.advertise ?? id;
	const management = portOf(config.listeners.management.address);
	const http = config.listeners.http?.address;
	return {
		id,
		address: `${host}:${management}`,
		serves: `${host}:${http === undefined ? management : portOf(http)}`,
		labels: config.cluster?.node.labels ?? {},
		capacity,
		auditHead: null
	};
}

/**
 * Joins a cluster, once.
 *
 * The join token is spent by this call, so a retry after a successful join fails by design: the
 * credential is what a child keeps, and re-running `cluster join` needs a fresh token from the
 * control node rather than replaying the old one.
 */
export async function join(
	ctx: Context,
	options: { control: string; token: string; report: NodeReport; state: string }
): Promise<Membership> {
	const answer = await post<JoinAnswer>(ctx, `${base(options.control)}${CLUSTER_PATHS.join}`, {
		protocol: CLUSTER_PROTOCOL,
		token: options.token,
		node: options.report
	});

	const membership: Membership = {
		protocol: answer.protocol,
		control: options.control,
		node: options.report.id,
		credential: answer.credential,
		cluster: answer.cluster,
		placement: answer.placement,
		nodes: [],
		heartbeatMs: answer.heartbeatMs,
		lastSyncedAt: ctx.now()
	};
	new MembershipStore(ctx, options.state).write(membership);
	return membership;
}

/**
 * One heartbeat, which is also how a child learns its placement changed.
 *
 * A failure is returned rather than thrown into the serving path: the node keeps serving what it
 * already holds, and `lastSyncedAt` going stale is what a tripwire reads.
 */
export async function heartbeat(
	ctx: Context,
	state: string,
	capacity: NodeReport['capacity'] = null
): Promise<{ membership: Membership | null; reached: boolean; reason: string }> {
	const store = new MembershipStore(ctx, state);
	const held = store.read();
	if (held === null)
		return { membership: null, reached: false, reason: 'this node has not joined' };

	try {
		const answer = await post<HeartbeatAnswer>(
			ctx,
			`${base(held.control)}${CLUSTER_PATHS.heartbeat}`,
			{ protocol: CLUSTER_PROTOCOL, node: { id: held.node, capacity, auditHead: null } },
			held.credential
		);
		const updated: Membership = {
			...held,
			cluster: answer.cluster,
			placement: answer.placement,
			nodes: answer.nodes,
			lastSyncedAt: ctx.now()
		};
		store.write(updated);
		return { membership: updated, reached: true, reason: '' };
	} catch (error) {
		return {
			membership: held,
			reached: false,
			reason: error instanceof Error ? error.message : String(error)
		};
	}
}
