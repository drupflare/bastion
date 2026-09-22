import { BastionError } from '../errors';

export type Scope = 'cluster' | 'node' | 'negotiated';

/**
 * Which keys the control node decides and which a child owns.
 *
 * Not a convention: a child that could lower a cluster-wide key locally makes the cluster's weakest
 * node its real security posture. A box does have its own NICs, disks and size, so pretending
 * otherwise makes a heterogeneous rack unusable -- hence the second column. The third is where the
 * control node proposes and the child may refuse.
 */
export const KEY_SCOPES: Record<string, Scope> = {
	mode: 'cluster',
	'runtime.floors': 'cluster',
	'runtime.limits': 'cluster',
	'runtime.unsafeEval': 'cluster',
	tenants: 'cluster',
	'audit.profile': 'cluster',

	listeners: 'node',
	state: 'node',
	front: 'node',
	drivers: 'node',
	'cluster.node': 'node',
	'limits.maxSites': 'node',
	logs: 'node',

	'runtime.residency': 'negotiated',
	'backup.target': 'negotiated'
};

export function scopeOf(key: string): Scope {
	const direct = KEY_SCOPES[key];
	if (direct !== undefined) return direct;
	const root = key.split('.')[0] as string;
	return KEY_SCOPES[root] ?? 'node';
}

export interface JoinOffer {
	/** the cluster-wide keys the control node is imposing */
	cluster: Record<string, unknown>;
	/** the negotiated keys it is proposing */
	proposed: Record<string, unknown>;
}

export interface JoinOutcome {
	accepted: boolean;
	/** the keys the child could not satisfy; a join refuses rather than joining degraded */
	refused: { key: string; reason: string }[];
	/** the negotiated keys the child countered on */
	countered: Record<string, unknown>;
}

export interface ChildCapability {
	/** modes this node can actually run, from its own preflight */
	modes: string[];
	memoryBytes: number;
	/** the number of sites this node can hold, from its own capacity reading */
	maxSites: number;
	/** whether this node can reach the proposed backup target */
	backupTargets: string[];
}

/**
 * Whether a child can join on the terms offered.
 *
 * **A child that receives a cluster-wide key it cannot satisfy refuses to join and says which key.**
 * Joining degraded is the same failure as a silent mode downgrade, one layer up: the cluster would
 * report a posture it does not have, and the weakest node would be the real one.
 */
export function evaluateOffer(offer: JoinOffer, capability: ChildCapability): JoinOutcome {
	const refused: { key: string; reason: string }[] = [];
	const countered: Record<string, unknown> = {};

	const mode = offer.cluster.mode;
	if (typeof mode === 'string' && !capability.modes.includes(mode)) {
		refused.push({
			key: 'mode',
			reason: `this node cannot run \`${mode}\`; it can run ${capability.modes.join(', ') || 'nothing'}`
		});
	}

	for (const [key, value] of Object.entries(offer.proposed)) {
		// every negotiated key is answered, agreed or countered. A key the child silently dropped
		// would read to the control node as one it never offered
		if (key === 'runtime.residency' && value === 'pin') {
			// pinning holds every site resident forever; a node that cannot fit them counters
			const fits = capability.maxSites > 0 && capability.memoryBytes > 0;
			countered[key] = fits ? 'pin' : 'evict';
			continue;
		}
		if (key === 'backup.target' && typeof value === 'string') {
			countered[key] = capability.backupTargets.includes(value)
				? value
				: (capability.backupTargets[0] ?? null);
			continue;
		}
		countered[key] = value;
	}

	return { accepted: refused.length === 0, refused, countered };
}

/** refuses a child trying to set a key the control node owns */
export function assertChildMaySet(key: string): void {
	if (scopeOf(key) === 'cluster') {
		throw new BastionError(
			'capability-refused',
			`${key} is decided by the control node; a child setting it locally would make the ` +
				"cluster's weakest node its real posture"
		);
	}
}
