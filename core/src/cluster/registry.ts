import type { Context } from '../context';
import { BastionError } from '../errors';

export type NodeState = 'joining' | 'ready' | 'draining' | 'unreachable' | 'left';

export interface ClusterNode {
	id: string;
	/** where this node's management listener answers */
	address: string;
	/** where this node serves sites; a forward dials this, not the management address */
	serves: string;
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
export const REGISTRY_FILE = 'cluster-nodes.json';

export class NodeRegistry {
	private readonly ctx: Context;
	private readonly nodes = new Map<string, ClusterNode>();
	private readonly path: string | null;

	/**
	 * @param state the state directory. Without one the registry is memory-only, which is the gate
	 * lane; a real control node always passes it, because the process a child heartbeats to is not
	 * the process an operator runs `cluster nodes` in.
	 */
	constructor(ctx: Context, state?: string) {
		this.ctx = ctx;
		this.path = state === undefined ? null : `${state}/${REGISTRY_FILE}`;
		this.replay();
	}

	private replay(): void {
		if (this.path === null || !this.ctx.files.exists(this.path)) return;
		try {
			const stored = JSON.parse(this.ctx.files.readText(this.path)) as ClusterNode[];
			this.nodes.clear();
			for (const node of stored) this.nodes.set(node.id, node);
		} catch {
			// a truncated registry rebuilds from the next heartbeat rather than failing the box
		}
	}

	private persist(): void {
		if (this.path === null) return;
		this.ctx.files.writeText(this.path, JSON.stringify([...this.nodes.values()]));
	}

	join(
		id: string,
		address: string,
		labels: Record<string, string> = {},
		serves?: string
	): ClusterNode {
		this.replay();
		const existing = this.nodes.get(id);
		const node: ClusterNode = {
			id,
			address,
			serves: serves ?? existing?.serves ?? address,
			labels,
			state: 'ready',
			lastSeenAt: this.ctx.now(),
			capacity: existing?.capacity ?? null,
			auditHead: existing?.auditHead ?? null
		};
		this.nodes.set(id, node);
		this.persist();
		return node;
	}

	heartbeat(
		id: string,
		report: { capacity?: ClusterNode['capacity']; auditHead?: string | null } = {}
	): ClusterNode {
		this.replay();
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
		this.persist();
		return updated;
	}

	drain(id: string): ClusterNode {
		const node = this.nodes.get(id);
		if (node === undefined) throw new BastionError('usage', `${id} is not in this cluster`);
		const updated = { ...node, state: 'draining' as const };
		this.nodes.set(id, updated);
		this.persist();
		return updated;
	}

	leave(id: string): void {
		const node = this.nodes.get(id);
		if (node !== undefined) this.nodes.set(id, { ...node, state: 'left' });
		this.persist();
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
		if (gone.length > 0) this.persist();
		return gone;
	}

	get(id: string): ClusterNode | null {
		this.replay();
		return this.nodes.get(id) ?? null;
	}

	list(): ClusterNode[] {
		this.replay();
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
