/**
 * The wire between two bastion nodes.
 *
 * This is the contract a control plane implements, so it is written down here rather than left
 * implicit in whichever handler happens to answer. Three rules shape all of it:
 *
 * **Children dial out and the control node never dials in.** A child behind NAT needs no inbound
 * rule, and the control node needs no credential for anyone else's box. Every exchange below is a
 * request made BY a child.
 *
 * **A join token is spent once and buys a long-lived node credential.** The token is minted on the
 * control node by `bastion cluster init` and carried to the child by whoever provisions it; it has
 * a short expiry because it is a bearer secret in transit. What the child keeps afterwards is its
 * own credential, revocable on its own.
 *
 * **Serving traffic does not come through here.** A node forwards a site request to the node that
 * holds it by dialling that node's ordinary http listener with the original `Host`, carrying
 * {@link HOP_HEADER} so the receiver knows not to forward it again. The cluster endpoints are for
 * membership and placement only, which keeps one loop guard rather than two protocols.
 */

import type { Mode, Residency } from '../config/types';
import type { Placement } from './placement';
import type { ClusterNode } from './registry';

/** bumped when a field changes meaning; a node refusing a version says which it speaks */
export const CLUSTER_PROTOCOL = 1;

export const CLUSTER_PREFIX = '/cluster/';

/**
 * Names the node a request has already been forwarded by.
 *
 * Without it two nodes that disagree about placement forward to each other forever. A request
 * carrying it is answered locally or refused, never forwarded again.
 */
export const HOP_HEADER = 'x-bastion-node';

/** what a child says about itself, so placement does not have to ask a second time */
export interface NodeReport {
	id: string;
	/** where this node's own management listener answers, for `cluster nodes` */
	address: string;
	/** where this node serves sites, which is what a forward dials */
	serves: string;
	labels: Record<string, string>;
	capacity: { sites: number; memoryBytes: number } | null;
	auditHead: string | null;
}

export interface JoinRequest {
	protocol: number;
	/** the one-time token `cluster init` minted; spent by this call */
	token: string;
	node: NodeReport;
}

/**
 * The cluster-wide keys a child may not decide for itself.
 *
 * A child that could lower any of these locally would make the cluster's weakest node its real
 * security posture, so they arrive from the control node and a child that cannot satisfy one
 * refuses to join and says which.
 */
export interface ClusterSettings {
	mode: Mode;
	residency: Residency;
	/** tenant names the cluster carries; a child holds a subset by placement */
	tenants: string[];
}

export interface JoinAnswer {
	protocol: number;
	/** this node's long-lived credential, presented on every later call */
	credential: string;
	cluster: ClusterSettings;
	placement: Placement[];
	heartbeatMs: number;
}

export interface HeartbeatRequest {
	protocol: number;
	node: Pick<NodeReport, 'id' | 'capacity' | 'auditHead'>;
}

export interface HeartbeatAnswer {
	protocol: number;
	cluster: ClusterSettings;
	placement: Placement[];
	nodes: ClusterNode[];
}

export interface NodesAnswer {
	protocol: number;
	nodes: ClusterNode[];
}

/**
 * What one node asks another to do to a site's replica lanes.
 *
 * `ownerToken` is the SITE's credential rather than the cluster's. The node credential gets the
 * caller as far as this endpoint; the worker's own `/replica` route checks the owner token, and
 * bastion does not mint or hold one on the site's behalf.
 */
export interface ReplicaRequest {
	protocol: number;
	site: string;
	action: 'provision' | 'snapshot' | 'status' | 'withdraw';
	lane?: number;
	ownerToken?: string;
}

export type ClusterPath = 'join' | 'heartbeat' | 'nodes' | 'replica';

export const CLUSTER_PATHS: Record<ClusterPath, string> = {
	join: `${CLUSTER_PREFIX}join`,
	heartbeat: `${CLUSTER_PREFIX}heartbeat`,
	nodes: `${CLUSTER_PREFIX}nodes`,
	replica: `${CLUSTER_PREFIX}replica`
};

/** the envelope every cluster endpoint answers with, matching the management API's */
export interface ClusterEnvelope<T> {
	ok: boolean;
	result?: T;
	error?: { code: string; message: string };
}

export function clusterPathOf(pathname: string): ClusterPath | null {
	for (const [name, path] of Object.entries(CLUSTER_PATHS)) {
		if (pathname === path) return name as ClusterPath;
	}
	return null;
}
