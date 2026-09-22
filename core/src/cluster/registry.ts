import type { Context } from '../context';
import { BastionError } from '../errors';

export type NodeState = 'joining' | 'ready' | 'draining' | 'unreachable' | 'left';

export interface ClusterNode {
	id: string;
	address: string;
	labels: Record<string, string>;
	state: NodeState;
	lastSeenAt: number;
	/** what this node reported it can hold, so placement does not have to ask */
	capacity: { sites: number; memoryBytes: number } | null;
	/** the head of this node's own audit chain, so a child rewriting history is detectable */
	auditHead: string | null;
}

export const HEARTBEAT_MS = 10_000;
export const UNREACHABLE_AFTER_MS = 30_000;

/**
 * The cluster registry, held by the control node.
 *
 * **Children dial out to it and it never dials in**, which matches the outbound-only posture the
 * roadmap already requires of control-plane pairing and means a child behind NAT needs no inbound
 * rule. A node that stops heartbeating is marked unreachable rather than removed: removing it would
 * let a partition look like a decommission and take its sites' placement with it.
 */
export class NodeRegistry {
	private readonly ctx: Context;
	private readonly nodes = new Map<string, ClusterNode>();

	constructor(ctx: Context) {
		this.ctx = ctx;
	}

	join(id: string, address: string, labels: Record<string, string> = {}): ClusterNode {
		const existing = this.nodes.get(id);
		const node: ClusterNode = {
			id,
			address,
			labels,
			state: 'ready',
			lastSeenAt: this.ctx.now(),
			capacity: existing?.capacity ?? null,
			auditHead: existing?.auditHead ?? null
		};
		this.nodes.set(id, node);
		return node;
	}

	heartbeat(
		id: string,
		report: { capacity?: ClusterNode['capacity']; auditHead?: string } = {}
	): ClusterNode {
		const node = this.nodes.get(id);
		if (node === undefined) throw new BastionError('usage', `${id} is not in this cluster`);
		const updated: ClusterNode = {
			...node,
			lastSeenAt: this.ctx.now(),
			state: node.state === 'unreachable' ? 'ready' : node.state,
			capacity: report.capacity ?? node.capacity,
			auditHead: report.auditHead ?? node.auditHead
		};
		this.nodes.set(id, updated);
		return updated;
	}

	drain(id: string): ClusterNode {
		const node = this.nodes.get(id);
		if (node === undefined) throw new BastionError('usage', `${id} is not in this cluster`);
		const updated = { ...node, state: 'draining' as const };
		this.nodes.set(id, updated);
		return updated;
	}

	leave(id: string): void {
		const node = this.nodes.get(id);
		if (node !== undefined) this.nodes.set(id, { ...node, state: 'left' });
	}

	/** marks anything that has not been heard from, without forgetting it */
	sweep(): string[] {
		const gone: string[] = [];
		for (const [id, node] of this.nodes) {
			if (node.state === 'left' || node.state === 'draining') continue;
			if (this.ctx.now() - node.lastSeenAt <= UNREACHABLE_AFTER_MS) continue;
			this.nodes.set(id, { ...node, state: 'unreachable' });
			gone.push(id);
		}
		return gone;
	}

	get(id: string): ClusterNode | null {
		return this.nodes.get(id) ?? null;
	}

	list(): ClusterNode[] {
		return [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
	}

	/** nodes that may take new work: ready, heard from, and not draining */
	available(): ClusterNode[] {
		return this.list().filter((node) => node.state === 'ready');
	}

	/**
	 * Compares each node's reported audit head against what it reported last time.
	 *
	 * A chain is per node, because one chain across nodes needs consensus that bastion does not have
	 * and should not grow. The registry holds the heads instead, so a child quietly rewriting its
	 * own history is detectable from outside it.
	 */
	auditHeads(): Record<string, string | null> {
		return Object.fromEntries(this.list().map((node) => [node.id, node.auditHead]));
	}
}
