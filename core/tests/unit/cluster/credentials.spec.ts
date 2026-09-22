import { describe, expect, it } from 'vitest';
import {
	JOIN_PREFIX,
	NODE_PREFIX,
	NodeCredentials,
	nodeBearer
} from '../../../src/cluster/credentials';
import { defaultContext } from '../../../src/context';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';

/**
 * Node credentials, which are deliberately not API tokens.
 *
 * An API token resolves to a PRINCIPAL with a role and a tenant. A node credential resolves to a
 * node and to nothing else, so a compromised child holds no operator role no matter what it
 * presents. The two populations are separate stores for that reason, and these specs assert the
 * separation holds rather than assuming it.
 */
function store(at = 1000) {
	const files = memoryFiles({});
	let now = at;
	const ctx = { ...defaultContext(), files, io: memoryIo(), now: () => now };
	return {
		files,
		tick: (ms: number) => (now += ms),
		// two instances over one disk, because minting and verifying are different processes
		control: new NodeCredentials(ctx, '/var/lib/bastion'),
		serve: new NodeCredentials(ctx, '/var/lib/bastion')
	};
}

describe('a join token', () => {
	it('is minted on one instance and redeemed on another', () => {
		const { control, serve } = store();
		const token = control.mintJoinToken();
		expect(token.startsWith(JOIN_PREFIX)).toBe(true);
		expect(serve.redeem(token, 'node-b')).not.toBe(null);
	});

	it('is spent once, so a replay buys nothing', () => {
		const { control, serve } = store();
		const token = control.mintJoinToken();
		expect(serve.redeem(token, 'node-b')).not.toBe(null);
		expect(serve.redeem(token, 'node-c')).toBe(null);
	});

	it('expires, because it is a bearer secret in transit', () => {
		const { control, serve, tick } = store();
		const token = control.mintJoinToken(60_000);
		tick(60_001);
		expect(serve.redeem(token, 'node-b')).toBe(null);
	});

	it('refuses a token that was never minted', () => {
		const { serve } = store();
		expect(serve.redeem('bsj_nothing', 'node-b')).toBe(null);
	});

	it('reports whether one is outstanding, so `cluster init` need not print twice', () => {
		const { control, tick } = store();
		expect(control.joinPending).toBe(false);
		control.mintJoinToken(60_000);
		expect(control.joinPending).toBe(true);
		tick(60_001);
		expect(control.joinPending).toBe(false);
	});

	it('keeps the hash rather than the token, so the file is not a credential', () => {
		const { control, files } = store();
		const token = control.mintJoinToken();
		expect(files.readText('/var/lib/bastion/cluster-credentials.json')).not.toContain(token);
	});
});

describe('a node credential', () => {
	it('resolves to the node it was issued to and to nothing else', () => {
		const { control, serve } = store();
		const secret = control.redeem(control.mintJoinToken(), 'node-b') as string;
		expect(secret.startsWith(NODE_PREFIX)).toBe(true);
		expect(serve.verify(secret)).toBe('node-b');
	});

	it('is not an api token, and an api token is not one of these', () => {
		const { control, serve } = store();
		control.redeem(control.mintJoinToken(), 'node-b');
		// the prefix the operator token store uses; nothing here may accept it
		expect(serve.verify('bst_an_api_token')).toBe(null);
		expect(serve.verify(null)).toBe(null);
		expect(serve.verify('no-prefix-at-all')).toBe(null);
	});

	it('stops working once revoked', () => {
		const { control, serve } = store();
		const secret = control.redeem(control.mintJoinToken(), 'node-b') as string;
		expect(serve.revoke('node-b')).toBe(true);
		expect(serve.verify(secret)).toBe(null);
		expect(serve.revoke('node-b')).toBe(false);
	});

	it('records when it was last seen, which is how a stale child is visible', () => {
		const { control, serve, tick } = store();
		const secret = control.redeem(control.mintJoinToken(), 'node-b') as string;
		tick(5_000);
		serve.verify(secret);
		expect(control.list()[0]?.lastSeenAt).toBe(6_000);
	});

	it('replaces a node rejoining rather than stacking a second credential for it', () => {
		const { control } = store();
		control.redeem(control.mintJoinToken(), 'node-b');
		control.redeem(control.mintJoinToken(), 'node-b');
		expect(control.list()).toHaveLength(1);
	});

	it('keeps an unrelated node working when another is revoked', () => {
		const { control, serve } = store();
		const first = control.redeem(control.mintJoinToken(), 'node-b') as string;
		const second = control.redeem(control.mintJoinToken(), 'node-c') as string;
		control.revoke('node-b');
		expect(serve.verify(first)).toBe(null);
		expect(serve.verify(second)).toBe('node-c');
	});
});

describe('nodeBearer', () => {
	it('reads the scheme case-insensitively, as the header allows', () => {
		const at = (value: string) =>
			nodeBearer(new Request('http://n/', { headers: { authorization: value } }));
		expect(at('Bearer abc')).toBe('abc');
		expect(at('bearer abc')).toBe('abc');
		expect(at('Basic abc')).toBe(null);
	});

	it('is null when there is no header at all', () => {
		expect(nodeBearer(new Request('http://n/'))).toBe(null);
	});
});
