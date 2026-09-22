import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import {
	SCRYPT_PARAMS,
	SESSION_TTL_MS,
	SessionStore,
	base32Decode,
	hashPassword,
	totp,
	totpValid,
	verifyPassword,
	type Account
} from '../../../src/serve/session';

let clock = 1_000_000;
function ctx() {
	return { ...defaultContext(), io: memoryIo(), env: {}, now: () => clock };
}

const password = 'correct horse battery staple';
// hashed at a cheap cost so the gate stays fast; the shipped default is asserted on its own below
const CHEAP = { N: 1024, r: 8, p: 1 };
const stored = hashPassword(password, undefined, CHEAP);
const account: Account = { id: 'op', role: 'operator', tenant: null, password: stored };

describe('password hashing', () => {
	it('verifies the right password and rejects the wrong one', () => {
		expect(verifyPassword(password, stored)).toBe(true);
		expect(verifyPassword('wrong', stored)).toBe(false);
	});

	it('salts, so two hashes of one password differ', () => {
		expect(hashPassword(password, undefined, CHEAP)).not.toBe(
			hashPassword(password, undefined, CHEAP)
		);
	});

	it('stores the parameters, so they can change without invalidating what is stored', () => {
		expect(stored.startsWith(`scrypt$${CHEAP.N}$8$1$`)).toBe(true);
	});

	it('ships a memory-hard default, whatever a caller passes for a test', () => {
		expect(SCRYPT_PARAMS.N).toBe(32768);
		expect(hashPassword('x').startsWith('scrypt$32768$8$1$')).toBe(true);
	});

	it('rejects a stored value in a scheme it does not know', () => {
		expect(verifyPassword(password, 'argon2id$x$y')).toBe(false);
		expect(verifyPassword(password, 'nonsense')).toBe(false);
	});
});

describe('TOTP', () => {
	// RFC 6238 appendix B, the SHA-1 seed "12345678901234567890" in base32
	const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

	it('is six digits', () => {
		expect(totp(secret, 59_000)).toMatch(/^\d{6}$/);
	});

	it('changes every thirty seconds and is stable inside one step', () => {
		expect(totp(secret, 0)).toBe(totp(secret, 29_000));
		expect(totp(secret, 0)).not.toBe(totp(secret, 30_000));
	});

	it('accepts a neighbouring window, because a phone clock is not the server s', () => {
		const code = totp(secret, 60_000);
		expect(totpValid(secret, code, 90_000)).toBe(true);
		expect(totpValid(secret, code, 180_000)).toBe(false);
	});

	it('decodes base32 padding and lowercase', () => {
		expect(base32Decode('MZXW6===').toString()).toBe('foo');
		expect(base32Decode('mzxw6').toString()).toBe('foo');
	});
});

describe('SessionStore', () => {
	it('logs in and issues a session with its own CSRF token', () => {
		const store = new SessionStore(ctx());
		const session = store.login(account, password);
		expect(session.principal.role).toBe('operator');
		expect(session.csrfToken).toHaveLength(43);
		expect(session.expiresAt).toBe(clock + SESSION_TTL_MS);
	});

	it('gives a different session id and token each time', () => {
		const store = new SessionStore(ctx());
		expect(store.login(account, password).id).not.toBe(store.login(account, password).id);
	});

	it('refuses a wrong password with a message that does not say which half was wrong', () => {
		const store = new SessionStore(ctx());
		const withTotp: Account = { ...account, totpSecret: 'GEZDGNBVGY3TQOJQ' };
		let passwordMessage = '';
		let totpMessage = '';
		try {
			store.login(withTotp, 'wrong', totp('GEZDGNBVGY3TQOJQ', clock));
		} catch (e) {
			passwordMessage = (e as Error).message;
		}
		try {
			store.login(withTotp, password, '000000');
		} catch (e) {
			totpMessage = (e as Error).message;
		}
		expect(passwordMessage).toBe(totpMessage);
	});

	it('throttles after five failures rather than allowing unlimited guesses', () => {
		const store = new SessionStore(ctx());
		for (let i = 0; i < 5; i++) {
			expect(() => store.login(account, 'wrong')).toThrow(/not right/);
		}
		expect(() => store.login(account, password)).toThrow(/too many attempts/);
	});

	it('clears the throttle on a successful login', () => {
		const store = new SessionStore(ctx());
		for (let i = 0; i < 4; i++) expect(() => store.login(account, 'wrong')).toThrow();
		expect(store.login(account, password).id).toBeTruthy();
		for (let i = 0; i < 4; i++) expect(() => store.login(account, 'wrong')).toThrow();
		expect(store.login(account, password).id).toBeTruthy();
	});

	it('expires a session rather than serving it forever', () => {
		const store = new SessionStore(ctx());
		const session = store.login(account, password);
		expect(store.get(session.id)?.id).toBe(session.id);
		clock += SESSION_TTL_MS + 1;
		expect(store.get(session.id)).toBe(null);
		expect(store.size).toBe(0);
		clock = 1_000_000;
	});

	it('answers null for an id it never issued', () => {
		expect(new SessionStore(ctx()).get('made-up')).toBe(null);
		expect(new SessionStore(ctx()).get(null)).toBe(null);
	});

	it('logs out', () => {
		const store = new SessionStore(ctx());
		const session = store.login(account, password);
		store.logout(session.id);
		expect(store.get(session.id)).toBe(null);
	});

	it('mints a one-time claim token that a second claim cannot reuse', () => {
		const store = new SessionStore(ctx());
		const token = store.mintClaimToken();
		expect(store.claimed).toBe(false);
		expect(store.claim(token)).toBe(true);
		expect(store.claim(token)).toBe(false);
		expect(store.claimed).toBe(true);
	});

	it('refuses a claim token that is not the one printed', () => {
		const store = new SessionStore(ctx());
		store.mintClaimToken();
		expect(store.claim('guessed')).toBe(false);
	});
});

/**
 * The claim token crosses a process boundary, because that is the whole point of it.
 *
 * `bastion dashboard token` runs at a shell and the claim is spent by a browser talking to
 * `serve`. Held in memory it was unusable: every claim answered no, because the process that
 * minted it had already exited.
 */
describe('a claim token between two processes', () => {
	const stores = () => {
		const files = memoryFiles({});
		const ctx = { ...defaultContext(), files, io: memoryIo(), now: () => 1000 };
		return {
			files,
			cli: new SessionStore(ctx, '/var/lib/bastion'),
			serve: new SessionStore(ctx, '/var/lib/bastion')
		};
	};

	it('is minted by one store and spent by another', () => {
		const { cli, serve } = stores();
		const token = cli.mintClaimToken();
		expect(serve.claimed).toBe(false);
		expect(serve.claim(token)).toBe(true);
	});

	it('is spent once, and the first store sees that too', () => {
		const { cli, serve } = stores();
		const token = cli.mintClaimToken();
		expect(serve.claim(token)).toBe(true);
		expect(cli.claim(token)).toBe(false);
		expect(cli.claimed).toBe(true);
	});

	it('stores the hash rather than the token, so the file is not a credential', () => {
		const { cli, files } = stores();
		const token = cli.mintClaimToken();
		const written = files.readText('/var/lib/bastion/console.json');
		expect(written).not.toContain(token);
		expect(JSON.parse(written).claim).toHaveLength(64);
	});

	it('answers no when nothing was ever minted', () => {
		const { serve } = stores();
		expect(serve.claimed).toBe(true);
		expect(serve.claim('anything')).toBe(false);
	});

	it('re-mints, which replaces the one before it', () => {
		const { cli, serve } = stores();
		const first = cli.mintClaimToken();
		const second = cli.mintClaimToken();
		expect(serve.claim(first)).toBe(false);
		expect(serve.claim(second)).toBe(true);
	});

	it('keeps sessions out of the file, since a list of live ids is a credential dump', () => {
		const { cli, files } = stores();
		cli.mintClaimToken();
		const session = cli.adopt({
			id: 'operator',
			role: 'operator',
			tenant: null,
			credential: 'session'
		});
		expect(files.readText('/var/lib/bastion/console.json')).not.toContain(session.id);
	});
});
