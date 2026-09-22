/**
 * The credentials nodes present to each other.
 *
 * Separate from `TokenStore` on purpose. An API token is a PRINCIPAL in the operator authz table,
 * with a role and a tenant; a node credential is not a principal at all and must never resolve to
 * one, or a compromised child would hold whatever role its token was minted with. Keeping the two
 * populations apart is what stops `/api/*` and `/cluster/*` from ever being reachable by the same
 * secret.
 *
 * Both halves live here: the one-time join token the control node mints, and the long-lived
 * per-node credential a join buys.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Context } from '../context';
import { constantTimeEqual } from '../serve/security';

export const NODE_FILE = 'cluster-credentials.json';
export const JOIN_TOKEN_TTL_MS = 60 * 60 * 1000;
export const NODE_PREFIX = 'bsn_';
export const JOIN_PREFIX = 'bsj_';

export interface NodeCredential {
	node: string;
	hash: string;
	createdAt: number;
	lastSeenAt: number | null;
	revokedAt: number | null;
}

interface Stored {
	/** the hash of the outstanding join token, and when it stops being accepted */
	join: { hash: string; expiresAt: number } | null;
	nodes: NodeCredential[];
}

const digest = (secret: string): string => createHash('sha256').update(secret).digest('hex');

export class NodeCredentials {
	private readonly ctx: Context;
	private readonly path: string;

	constructor(ctx: Context, state: string) {
		this.ctx = ctx;
		this.path = `${state}/${NODE_FILE}`;
	}

	/** re-read on every call, because the process that mints is never the process that verifies */
	private read(): Stored {
		if (!this.ctx.files.exists(this.path)) return { join: null, nodes: [] };
		try {
			return JSON.parse(this.ctx.files.readText(this.path)) as Stored;
		} catch {
			return { join: null, nodes: [] };
		}
	}

	private write(stored: Stored): void {
		this.ctx.files.writeText(this.path, JSON.stringify(stored));
		this.ctx.files.chmod(this.path, 0o600);
	}

	/** mints the one-time token a child carries to its first call; only the hash is kept */
	mintJoinToken(ttlMs = JOIN_TOKEN_TTL_MS): string {
		const token = `${JOIN_PREFIX}${randomBytes(24).toString('base64url')}`;
		this.write({
			...this.read(),
			join: { hash: digest(token), expiresAt: this.ctx.now() + ttlMs }
		});
		return token;
	}

	get joinPending(): boolean {
		const stored = this.read().join;
		return stored !== null && stored.expiresAt > this.ctx.now();
	}

	/**
	 * Spends the join token and issues that node its own credential.
	 *
	 * One call: a token that verified but failed to produce a credential would leave a child able
	 * to retry with a secret the control node thinks is spent.
	 */
	redeem(token: string, node: string): string | null {
		const stored = this.read();
		if (stored.join === null || stored.join.expiresAt <= this.ctx.now()) return null;
		if (!constantTimeEqual(digest(token), stored.join.hash)) return null;

		const secret = `${NODE_PREFIX}${randomBytes(24).toString('base64url')}`;
		const credential: NodeCredential = {
			node,
			hash: digest(secret),
			createdAt: this.ctx.now(),
			lastSeenAt: null,
			revokedAt: null
		};
		this.write({
			join: null,
			nodes: [...stored.nodes.filter((entry) => entry.node !== node), credential]
		});
		return secret;
	}

	/** the node a presented credential belongs to, or null; never a principal */
	verify(secret: string | null): string | null {
		if (secret === null || !secret.startsWith(NODE_PREFIX)) return null;
		const stored = this.read();
		const presented = digest(secret);
		for (const credential of stored.nodes) {
			if (!constantTimeEqual(presented, credential.hash)) continue;
			if (credential.revokedAt !== null) return null;
			this.write({
				...stored,
				nodes: stored.nodes.map((entry) =>
					entry.node === credential.node
						? { ...entry, lastSeenAt: this.ctx.now() }
						: entry
				)
			});
			return credential.node;
		}
		return null;
	}

	revoke(node: string): boolean {
		const stored = this.read();
		const found = stored.nodes.find((entry) => entry.node === node);
		if (found === undefined || found.revokedAt !== null) return false;
		this.write({
			...stored,
			nodes: stored.nodes.map((entry) =>
				entry.node === node ? { ...entry, revokedAt: this.ctx.now() } : entry
			)
		});
		return true;
	}

	list(): NodeCredential[] {
		return this.read().nodes;
	}
}

/** reads a bearer credential, the same way the management API reads its own */
export function nodeBearer(request: Request): string | null {
	const header = request.headers.get('authorization');
	if (header === null) return null;
	const [scheme, ...rest] = header.split(' ');
	return scheme?.toLowerCase() === 'bearer' ? rest.join(' ') : null;
}
