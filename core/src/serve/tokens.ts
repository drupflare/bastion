import { createHash, randomBytes } from 'node:crypto';
import type { Principal, Role } from '../api/authz';
import type { Context } from '../context';
import { constantTimeEqual } from './security';

export interface ApiToken {
	id: string;
	name: string;
	role: Role;
	tenant: string | null;
	/** the SHA-256 of the secret; the secret itself is shown once and never stored */
	hash: string;
	createdAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
	expiresAt: number | null;
}

export const TOKEN_PREFIX = 'bst_';

export function tokenHash(secret: string): string {
	return createHash('sha256').update(secret).digest('hex');
}

/**
 * Scoped, revocable API tokens, separate from sessions.
 *
 * A tenant-scoped token is what makes self-service work: a signup form calls the management API to
 * create a site under the `students` tenant, and it cannot reach another tenant or the host because
 * the token carries the tenant exactly the way a session does.
 *
 * The secret is shown once. Storing it would make the token list a credential dump, and there is
 * no operation that needs the plaintext after issue.
 */
export const TOKEN_FILE = 'tokens.json';

export class TokenStore {
	private readonly ctx: Context;
	private readonly tokens = new Map<string, ApiToken>();
	private readonly path: string | null;

	/**
	 * @param state the state directory; without one the store is memory-only, which is the gate
	 * lane. A real box always passes it: the process that mints a token is never the process that
	 * checks it, so a token held only in memory is a token that has never worked.
	 */
	constructor(ctx: Context, state?: string) {
		this.ctx = ctx;
		this.path = state === undefined ? null : `${state}/${TOKEN_FILE}`;
		this.replay();
	}

	/**
	 * Re-reads the file, replacing what is held.
	 *
	 * Called before every read as well as at construction, because the process that mints a token
	 * is never the process that checks it: a long-lived `serve` that replayed once at startup
	 * refused every token issued after it started, and saw a revoked one as live forever.
	 *
	 * Replaces rather than merges, so a revocation in another process is visible here.
	 */
	private replay(): void {
		if (this.path === null || !this.ctx.files.exists(this.path)) return;
		try {
			const stored = JSON.parse(this.ctx.files.readText(this.path)) as ApiToken[];
			this.tokens.clear();
			for (const token of stored) this.tokens.set(token.id, token);
		} catch {
			// a truncated file loses the tokens rather than the box; the operator reissues
		}
	}

	private persist(): void {
		if (this.path === null) return;
		this.ctx.files.writeText(this.path, JSON.stringify([...this.tokens.values()]));
		// hashes rather than secrets, and still nobody else's business
		this.ctx.files.chmod(this.path, 0o600);
	}

	create(
		name: string,
		role: Role,
		tenant: string | null,
		expiresAt: number | null = null
	): { token: ApiToken; secret: string } {
		this.replay();
		const secret = `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
		const token: ApiToken = {
			id: randomBytes(8).toString('hex'),
			name,
			role,
			tenant,
			hash: tokenHash(secret),
			createdAt: this.ctx.now(),
			lastUsedAt: null,
			revokedAt: null,
			expiresAt
		};
		this.tokens.set(token.id, token);
		this.persist();
		return { token, secret };
	}

	list(): ApiToken[] {
		this.replay();
		return [...this.tokens.values()].map((token) => ({ ...token }));
	}

	revoke(id: string): boolean {
		this.replay();
		const token = this.tokens.get(id);
		if (token === undefined || token.revokedAt !== null) return false;
		this.tokens.set(id, { ...token, revokedAt: this.ctx.now() });
		this.persist();
		return true;
	}

	/** resolves a presented secret to a principal, comparing in constant time */
	resolve(secret: string | null): Principal | null {
		if (secret === null || !secret.startsWith(TOKEN_PREFIX)) return null;
		this.replay();
		const presented = tokenHash(secret);
		for (const token of this.tokens.values()) {
			if (!constantTimeEqual(presented, token.hash)) continue;
			if (token.revokedAt !== null) return null;
			if (token.expiresAt !== null && token.expiresAt <= this.ctx.now()) return null;
			this.tokens.set(token.id, { ...token, lastUsedAt: this.ctx.now() });
			this.persist();
			return { id: token.id, role: token.role, tenant: token.tenant, credential: 'token' };
		}
		return null;
	}
}

/** reads a bearer token out of the Authorization header */
export function bearer(request: Request): string | null {
	const header = request.headers.get('authorization');
	if (header === null) return null;
	const [scheme, ...rest] = header.split(' ');
	return scheme?.toLowerCase() === 'bearer' ? rest.join(' ') : null;
}
