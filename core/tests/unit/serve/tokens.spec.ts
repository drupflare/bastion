import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { memoryIo } from '../../../src/io';
import { TOKEN_PREFIX, TokenStore, bearer } from '../../../src/serve/tokens';

let clock = 1000;
function store() {
	return new TokenStore({ ...defaultContext(), io: memoryIo(), env: {}, now: () => clock });
}

describe('TokenStore', () => {
	it('shows the secret once and never stores it', () => {
		const tokens = store();
		const { token, secret } = tokens.create('ci', 'tenant-admin', 'acme');
		expect(secret.startsWith(TOKEN_PREFIX)).toBe(true);
		expect(JSON.stringify(tokens.list())).not.toContain(secret);
		expect(token.hash).not.toBe(secret);
	});

	it('resolves a presented secret to a scoped principal', () => {
		const tokens = store();
		const { secret } = tokens.create('ci', 'tenant-admin', 'acme');
		expect(tokens.resolve(secret)).toMatchObject({
			role: 'tenant-admin',
			tenant: 'acme',
			credential: 'token'
		});
	});

	it('answers null for anything that is not one of its tokens', () => {
		const tokens = store();
		tokens.create('ci', 'tenant-admin', 'acme');
		expect(tokens.resolve('bst_wrong')).toBe(null);
		expect(tokens.resolve('not-even-a-token')).toBe(null);
		expect(tokens.resolve(null)).toBe(null);
	});

	it('stops resolving once revoked', () => {
		const tokens = store();
		const { token, secret } = tokens.create('ci', 'tenant-admin', 'acme');
		expect(tokens.revoke(token.id)).toBe(true);
		expect(tokens.resolve(secret)).toBe(null);
		expect(tokens.revoke(token.id)).toBe(false);
	});

	it('stops resolving once expired', () => {
		const tokens = store();
		const { secret } = tokens.create('ci', 'tenant-admin', 'acme', 2000);
		expect(tokens.resolve(secret)).not.toBe(null);
		clock = 2001;
		expect(tokens.resolve(secret)).toBe(null);
		clock = 1000;
	});

	it('records when a token was last used, which is what makes an unused one findable', () => {
		const tokens = store();
		const { token, secret } = tokens.create('ci', 'tenant-admin', 'acme');
		expect(tokens.list().find((t) => t.id === token.id)?.lastUsedAt).toBe(null);
		tokens.resolve(secret);
		expect(tokens.list().find((t) => t.id === token.id)?.lastUsedAt).toBe(1000);
	});

	it('revoking something that does not exist is false rather than an error', () => {
		expect(store().revoke('nope')).toBe(false);
	});
});

describe('bearer', () => {
	it('reads a bearer token and ignores another scheme', () => {
		expect(
			bearer(new Request('https://h/', { headers: { authorization: 'Bearer abc' } }))
		).toBe('abc');
		expect(bearer(new Request('https://h/', { headers: { authorization: 'Basic abc' } }))).toBe(
			null
		);
		expect(bearer(new Request('https://h/'))).toBe(null);
	});
});
