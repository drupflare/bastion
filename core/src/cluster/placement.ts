import { BastionError } from '../errors';
import type { ClusterNode } from './registry';

export interface Placement {
	site: string;
	tenant: string;
	primary: string;
	replicas: string[];
}

export const REPLICA_LAG_MS = 30_000;

export interface PlacementInput {
	site: string;
	tenant: string;
	nodes: ClusterNode[];
	/** how many replica nodes to add beside the primary */
	replicas?: number;
	/** placements already made, so the planner can balance rather than stack */
	existing?: Placement[];
	/** a label every candidate node must carry, for a rack or a campus constraint */
	require?: Record<string, string>;
}

function sitesOn(node: string, existing: Placement[]): number {
	return existing.filter((p) => p.primary === node).length;
}

/**
 * Chooses a primary node and its replicas.
 *
 * Least-loaded first, and a replica never shares a node with the primary -- a replica on the same
 * box is a copy that dies with the original, which is the failure mode a replica exists to avoid.
 * Where nodes carry labels, a replica prefers a node whose labels DIFFER from the primary's, so a
 * rack label actually buys rack diversity rather than being decoration.
 */
export function plan(input: PlacementInput): Placement {
	const existing = input.existing ?? [];
	const candidates = input.nodes
		.filter((node) => node.state === 'ready')
		.filter((node) =>
			Object.entries(input.require ?? {}).every(([key, value]) => node.labels[key] === value)
		);
	if (candidates.length === 0) {
		throw new BastionError(
			'capacity-exceeded',
			`no ready node satisfies the placement for ${input.site}`,
			{
				next: 'bastion cluster nodes'
			}
		);
	}
	const byLoad = [...candidates].sort(
		(a, b) => sitesOn(a.id, existing) - sitesOn(b.id, existing) || a.id.localeCompare(b.id)
	);
	const primary = byLoad[0] as ClusterNode;

	const wanted = Math.min(input.replicas ?? 0, byLoad.length - 1);
	const others = byLoad.slice(1);
	const differentRack = others.filter((node) =>
		Object.entries(primary.labels).some(([key, value]) => node.labels[key] !== value)
	);
	const ordered = [...differentRack, ...others.filter((node) => !differentRack.includes(node))];

	return {
		site: input.site,
		tenant: input.tenant,
		primary: primary.id,
		replicas: ordered.slice(0, wanted).map((node) => node.id)
	};
}

export interface PromotionPlan {
	site: string;
	from: string;
	to: string;
	/** the worst-case window of writes that may be lost, stated BEFORE the promotion acts */
	worstCaseLossMs: number;
	lastReplicatedAt: number | null;
	warning: string;
}

/**
 * What a failover costs, computed before it happens.
 *
 * Promoting a replica makes its snapshot authoritative and loses anything not yet replicated. The
 * window is bounded by the replication lag, so bastion states the worst case rather than implying
 * there is none. An operator who reads "up to 30 seconds of writes" and proceeds has made a
 * decision; one who is told nothing has had it made for them.
 */
export function planPromotion(
	placement: Placement,
	to: string,
	lastReplicatedAt: number | null,
	now: number,
	lagMs = REPLICA_LAG_MS
): PromotionPlan {
	if (!placement.replicas.includes(to)) {
		throw new BastionError('usage', `${to} holds no replica of ${placement.site}`);
	}
	const measured = lastReplicatedAt === null ? lagMs : Math.max(0, now - lastReplicatedAt);
	return {
		site: placement.site,
		from: placement.primary,
		to,
		worstCaseLossMs: measured,
		lastReplicatedAt,
		warning:
			lastReplicatedAt === null
				? `nothing is recorded about the last replication, so assume the full ${lagMs}ms window`
				: `writes in the last ${measured}ms may not have reached ${to} and will be lost`
	};
}

export function promote(placement: Placement, to: string): Placement {
	if (!placement.replicas.includes(to)) {
		throw new BastionError('usage', `${to} holds no replica of ${placement.site}`);
	}
	return {
		...placement,
		primary: to,
		replicas: [...placement.replicas.filter((node) => node !== to), placement.primary]
	};
}
