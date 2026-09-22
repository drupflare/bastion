/**
 * Cross-node routing, which is a different decision from the worker's lane routing.
 *
 * Two layers, and the inner one is NOT reimplemented here. bastion decides which NODE answers;
 * inside a node the worker's own `chooseTarget()` picks a lane with `REPLICA_COUNT` set to that
 * node's local lanes, unchanged. The constants below mirror the sibling's, and a spec reads its
 * source and fails on disagreement -- a second copy of "which requests may be spread" written in
 * bastion's own words is the drift that costs a correctness property.
 */
export const SPREAD_ROUTES: ReadonlySet<string> = new Set(['/serve']);

export type NodeRole = 'primary' | 'replica';

export interface NodeDecision {
	node: string;
	role: NodeRole;
	reason: string;
}

export interface NodeRouteInput {
	site: string;
	method: string;
	/** the node this request arrived at */
	localNode: string;
	primaryNode: string;
	replicaNodes: string[];
	/** the rewritten pathname; absent pins to the primary */
	pathname?: string;
	/** whether the request already carries a session */
	hasSession?: boolean;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Which node answers.
 *
 * The three pins are the sibling's, for the sibling's measured reasons. A write goes to the
 * primary. **A write carrying no session may establish one, and a replica cannot** -- login,
 * registration and password reset are exactly the writes that arrive without a session, and a lane
 * answering one hands the client a session id the primary does not have; it presents as "the site
 * stopped accepting the password". And only the serving path is spreadable at all, as an
 * allow-list of one rather than a deny-list, because a route wrongly spread answers from a copy.
 */
export function chooseNode(input: NodeRouteInput): NodeDecision {
	const primary: NodeDecision = {
		node: input.primaryNode,
		role: 'primary',
		reason: 'the primary holds the authoritative object'
	};
	if (input.replicaNodes.length === 0) {
		return { ...primary, reason: 'this site has no replica nodes' };
	}
	if (WRITE_METHODS.has(input.method.toUpperCase())) {
		return { ...primary, reason: `${input.method} is a write` };
	}
	if (!SPREAD_ROUTES.has(input.pathname ?? '')) {
		return {
			...primary,
			reason: `${input.pathname ?? 'an unnamed route'} is not the serving path`
		};
	}
	if (input.hasSession !== true && WRITE_METHODS.has(input.method.toUpperCase())) {
		return { ...primary, reason: 'a write carrying no session may establish one' };
	}
	if (!input.replicaNodes.includes(input.localNode)) {
		return { ...primary, reason: 'this node holds no replica for that site' };
	}
	return {
		node: input.localNode,
		role: 'replica',
		reason: 'a read on the serving path, served from the local replica'
	};
}

/**
 * Whether the request must be proxied off this node.
 *
 * Kept separate from the decision so a caller cannot forget to ask: a decision naming another node
 * is a proxy, and one naming this node is served locally.
 */
export function mustProxy(decision: NodeDecision, localNode: string): boolean {
	return decision.node !== localNode;
}
