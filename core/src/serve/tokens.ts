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
export class TokenStore {
	private readonly ctx: Context;
	private readonly tokens = new Map<string, ApiToken>();

	constructor(ctx: Context) {
		this.ctx = ctx;
	}

	create(
		name: string,
		role: Role,
		tenant: string | null,
		expiresAt: number | null = null
	): { token: ApiToken; secret: string } {
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
		return { token, secret };
	}

	list(): ApiToken[] {
		return [...this.tokens.values()].map((token) => ({ ...token }));
	}

	revoke(id: string): boolean {
		const token = this.tokens.get(id);
		if (token === undefined || token.revokedAt !== null) return false;
		this.tokens.set(id, { ...token, revokedAt: this.ctx.now() });
		return true;
	}

	/** resolves a presented secret to a principal, comparing in constant time */
	resolve(secret: string | null): Principal | null {
		if (secret === null || !secret.startsWith(TOKEN_PREFIX)) return null;
		const presented = tokenHash(secret);
		for (const token of this.tokens.values()) {
			if (!constantTimeEqual(presented, token.hash)) continue;
			if (token.revokedAt !== null) return null;
			if (token.expiresAt !== null && token.expiresAt <= this.ctx.now()) return null;
			this.tokens.set(token.id, { ...token, lastUsedAt: this.ctx.now() });
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
