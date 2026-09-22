import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Principal, Role } from '../api/authz';
import type { Context } from '../context';
import { BastionError } from '../errors';
import { constantTimeEqual } from './security';

export interface Account {
	id: string;
	role: Role;
	tenant: string | null;
	/** `scrypt$N$r$p$salt$hash`; see the note on argon2id below */
	password: string;
	totpSecret?: string;
}

export interface Session {
	id: string;
	principal: Principal;
	csrfToken: string;
	createdAt: number;
	expiresAt: number;
}

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Password hashing.
 *
 * The plan called for argon2id and node ships scrypt instead, so this is scrypt at parameters
 * chosen for the same property: memory-hardness, at a cost a login can pay and a cracking rig
 * cannot amortise. N=2^15, r=8, p=1 is roughly 32 MiB per attempt. Swapping in argon2id later is a
 * new prefix in the same stored string, which is why the parameters are stored rather than assumed.
 */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keylen: 32 } as const;

/**
 * `params` exists so a test can hash at a cost it can afford without lowering the shipped default,
 * which is what a caller gets when it passes nothing. The cost is stored in the hash, so raising
 * the default later does not invalidate anything already written.
 */
export function hashPassword(
	password: string,
	salt?: Buffer,
	params: { N: number; r: number; p: number } = SCRYPT_PARAMS
): string {
	const used = salt ?? randomBytes(16);
	const hash = scryptSync(password, used, SCRYPT_PARAMS.keylen, {
		N: params.N,
		r: params.r,
		p: params.p,
		maxmem: 256 * 1024 * 1024
	});
	return `scrypt$${params.N}$${params.r}$${params.p}$${used.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const [scheme, n, r, p, salt, expected] = stored.split('$');
	if (scheme !== 'scrypt' || salt === undefined || expected === undefined) return false;
	const hash = scryptSync(password, Buffer.from(salt, 'base64'), SCRYPT_PARAMS.keylen, {
		N: Number(n),
		r: Number(r),
		p: Number(p),
		maxmem: 256 * 1024 * 1024
	});
	const want = Buffer.from(expected, 'base64');
	return hash.length === want.length && timingSafeEqual(hash, want);
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(text: string): Buffer {
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const char of text.toUpperCase().replace(/=+$/, '')) {
		const index = BASE32.indexOf(char);
		if (index === -1) continue;
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/** RFC 6238, the six-digit thirty-second variety every authenticator app speaks */
export function totp(secret: string, at: number, stepSeconds = 30, digits = 6): string {
	const counter = Math.floor(at / 1000 / stepSeconds);
	const buffer = Buffer.alloc(8);
	buffer.writeBigUInt64BE(BigInt(counter));
	const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
	const offset = (digest[digest.length - 1] as number) & 0x0f;
	const binary =
		(((digest[offset] as number) & 0x7f) << 24) |
		((digest[offset + 1] as number) << 16) |
		((digest[offset + 2] as number) << 8) |
		(digest[offset + 3] as number);
	return String(binary % 10 ** digits).padStart(digits, '0');
}

/** accepts the neighbouring windows, because a phone's clock is not the server's */
export function totpValid(secret: string, code: string, at: number, skew = 1): boolean {
	for (let step = -skew; step <= skew; step++) {
		if (constantTimeEqual(totp(secret, at + step * 30_000), code)) return true;
	}
	return false;
}

/**
 * Sessions, in memory, on the management listener.
 *
 * Local auth works with no internet, which is the point: the failure mode where the dashboard is
 * most needed is the one where the box reaches nothing. A first run prints a one-time claim token
 * rather than shipping a default password.
 */
export class SessionStore {
	private readonly ctx: Context;
	private readonly sessions = new Map<string, Session>();
	private readonly failures = new Map<string, { count: number; until: number }>();
	private claimToken: string | null = null;

	constructor(ctx: Context) {
		this.ctx = ctx;
	}

	/** the one-time token a first run prints; consumed by the first account created */
	mintClaimToken(): string {
		this.claimToken = randomBytes(24).toString('base64url');
		return this.claimToken;
	}

	claim(token: string): boolean {
		if (this.claimToken === null) return false;
		if (!constantTimeEqual(token, this.claimToken)) return false;
		this.claimToken = null;
		return true;
	}

	get claimed(): boolean {
		return this.claimToken === null;
	}

	/** a per-account budget, so a password guess costs an attacker a wait rather than nothing */
	private throttled(id: string): boolean {
		const record = this.failures.get(id);
		return record !== undefined && record.count >= 5 && this.ctx.now() < record.until;
	}

	login(account: Account, password: string, totpCode?: string): Session {
		if (this.throttled(account.id)) {
			throw new BastionError('capability-refused', 'too many attempts; wait and try again', {
				retryable: true
			});
		}
		const passwordOk = verifyPassword(password, account.password);
		const totpOk =
			account.totpSecret === undefined ||
			(totpCode !== undefined && totpValid(account.totpSecret, totpCode, this.ctx.now()));
		if (!passwordOk || !totpOk) {
			const record = this.failures.get(account.id) ?? { count: 0, until: 0 };
			this.failures.set(account.id, {
				count: record.count + 1,
				until: this.ctx.now() + 60_000
			});
			// one message for both, so a wrong password and a wrong code are indistinguishable
			throw new BastionError('capability-refused', 'those credentials are not right');
		}
		this.failures.delete(account.id);
		const session: Session = {
			id: randomBytes(32).toString('base64url'),
			principal: {
				id: account.id,
				role: account.role,
				tenant: account.tenant,
				credential: 'session'
			},
			csrfToken: randomBytes(32).toString('base64url'),
			createdAt: this.ctx.now(),
			expiresAt: this.ctx.now() + SESSION_TTL_MS
		};
		this.sessions.set(session.id, session);
		return session;
	}

	get(id: string | null): Session | null {
		if (id === null) return null;
		const session = this.sessions.get(id);
		if (session === undefined) return null;
		if (session.expiresAt <= this.ctx.now()) {
			this.sessions.delete(id);
			return null;
		}
		return session;
	}

	logout(id: string): void {
		this.sessions.delete(id);
	}

	get size(): number {
		return this.sessions.size;
	}
}
