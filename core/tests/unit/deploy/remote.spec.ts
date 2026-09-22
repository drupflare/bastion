import { describe, expect, it } from 'vitest';
import { defaultContext, type Context } from '../../../src/context';
import {
	addressBytes,
	assertFetchable,
	bundleName,
	deniedRange,
	fetchRemote,
	isRemote,
	probeRemote,
	pullBundle
} from '../../../src/deploy/remote';
import { memoryFiles } from '../../../src/host/files';

/**
 * A url in `--bundle` or `--template` is an instruction to fetch code and run it as a tenant, so
 * every refusal here is exercised from both sides: the thing it stops, and the case it must let
 * through. A guard that cannot fire and a guard that fires on everything both read as a passing
 * spec unless each side is named.
 */
const ok = (body: string, headers: Record<string, string> = {}): Response =>
	new Response(body, { headers: { 'content-length': String(body.length), ...headers } });

interface Call {
	url: string;
	method: string;
}

/** answers each url from a table, recording what was asked, so redirect chains are assertable */
function fetcher(table: Record<string, Response | (() => Response)>): {
	fetch: Context['fetch'];
	calls: Call[];
} {
	const calls: Call[] = [];
	return {
		calls,
		fetch: ((input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input.toString();
			calls.push({ url, method: init?.method ?? 'GET' });
			const answer = table[url];
			if (answer === undefined) return Promise.resolve(new Response('', { status: 404 }));
			return Promise.resolve(typeof answer === 'function' ? answer() : answer.clone());
		}) as Context['fetch']
	};
}

const publicly = () => Promise.resolve(['93.184.216.34']);
const base = { maxBytes: 1024, resolve: publicly };

function ctxWith(table: Record<string, Response | (() => Response)>): Context & { calls: Call[] } {
	const { fetch, calls } = fetcher(table);
	return { ...defaultContext(), fetch, files: memoryFiles(), calls };
}

describe('isRemote', () => {
	it('takes a url and leaves a path alone', () => {
		expect(isRemote('https://example.edu/p.tar.gz')).toBe(true);
		expect(isRemote('./payload.tar.gz')).toBe(false);
		expect(isRemote('/srv/payload.tar.gz')).toBe(false);
		// a windows drive letter is a path; the scheme rule alone would read it as one
		expect(isRemote('C:\\payload.tar.gz')).toBe(false);
	});
});

describe('addressBytes', () => {
	it('reads v4', () => {
		expect([...(addressBytes('10.0.0.1') as Uint8Array)]).toEqual([10, 0, 0, 1]);
	});

	it('refuses an octet over 255, which would otherwise wrap into a different address', () => {
		expect(addressBytes('10.0.0.256')).toBe(null);
	});

	it('expands the compressed form', () => {
		expect([...(addressBytes('::1') as Uint8Array)]).toEqual([
			0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1
		]);
	});

	it('reads a full v6 address', () => {
		const bytes = addressBytes('fe80:0000:0000:0000:0000:0000:0000:0001') as Uint8Array;
		expect(bytes.byteLength).toBe(16);
		expect(bytes[0]).toBe(0xfe);
		expect(bytes[1]).toBe(0x80);
	});

	it('normalises a v4-mapped address to four bytes, so the v4 ranges catch it', () => {
		expect([...(addressBytes('::ffff:127.0.0.1') as Uint8Array)]).toEqual([127, 0, 0, 1]);
	});

	it('refuses two compressions, which have no single expansion', () => {
		expect(addressBytes('1::2::3')).toBe(null);
	});

	it('refuses a hostname', () => {
		expect(addressBytes('example.edu')).toBe(null);
	});
});

describe('deniedRange', () => {
	it('catches the metadata endpoint that hands out instance credentials', () => {
		expect(deniedRange('169.254.169.254')).toBe('169.254.0.0/16');
	});

	it('catches loopback, which is where the management listener is', () => {
		expect(deniedRange('127.0.0.1')).toBe('127.0.0.0/8');
	});

	it('catches the three private v4 ranges', () => {
		expect(deniedRange('10.1.2.3')).toBe('10.0.0.0/8');
		expect(deniedRange('172.20.0.5')).toBe('172.16.0.0/12');
		expect(deniedRange('192.168.1.9')).toBe('192.168.0.0/16');
	});

	it('does not catch the addresses either side of a partial-byte mask', () => {
		expect(deniedRange('172.15.255.255')).toBe(null);
		expect(deniedRange('172.32.0.1')).toBe(null);
	});

	it('catches the v6 ranges', () => {
		expect(deniedRange('::1')).toBe('::1/128');
		expect(deniedRange('fd00::1')).toBe('fc00::/7');
		expect(deniedRange('fe80::1')).toBe('fe80::/10');
	});

	it('leaves a public address alone', () => {
		expect(deniedRange('93.184.216.34')).toBe(null);
		expect(deniedRange('2606:2800:220:1::1')).toBe(null);
	});
});

describe('assertFetchable', () => {
	it('takes an https url that resolves publicly', async () => {
		await expect(assertFetchable('https://example.edu/p.tgz', base)).resolves.toBeUndefined();
	});

	it('refuses a scheme that is not http', async () => {
		await expect(assertFetchable('ftp://example.edu/p.tgz', base)).rejects.toThrow('not ftp');
	});

	it('refuses plaintext, which is a man in the middle away from arbitrary code', async () => {
		await expect(assertFetchable('http://example.edu/p.tgz', base)).rejects.toThrow(
			'is plaintext'
		);
	});

	it('takes plaintext once the operator says so', async () => {
		await expect(
			assertFetchable('http://example.edu/p.tgz', { ...base, insecure: true })
		).resolves.toBeUndefined();
	});

	it('refuses a name that resolves into a denied range', async () => {
		await expect(
			assertFetchable('https://mirror.edu/p.tgz', {
				...base,
				resolve: () => Promise.resolve(['169.254.169.254'])
			})
		).rejects.toThrow('169.254.0.0/16');
	});

	it('refuses when any answer is denied, not only the first', async () => {
		await expect(
			assertFetchable('https://mirror.edu/p.tgz', {
				...base,
				resolve: () => Promise.resolve(['93.184.216.34', '127.0.0.1'])
			})
		).rejects.toThrow('127.0.0.1');
	});

	it('refuses an address literal without asking a resolver at all', async () => {
		await expect(
			assertFetchable('https://127.0.0.1/p.tgz', {
				...base,
				resolve: () => Promise.reject(new Error('the resolver must not be reached'))
			})
		).rejects.toThrow('127.0.0.0/8');
	});

	it('refuses a bracketed v6 literal in a denied range', async () => {
		await expect(
			assertFetchable('https://[::1]/p.tgz', {
				...base,
				resolve: () => Promise.reject(new Error('the resolver must not be reached'))
			})
		).rejects.toThrow('::1/128');
	});

	it('refuses a name that resolves to nothing', async () => {
		await expect(
			assertFetchable('https://gone.edu/p.tgz', {
				...base,
				resolve: () => Promise.resolve([])
			})
		).rejects.toThrow('resolves to nothing');
	});

	it('takes a private address once the operator vouches for the mirror', async () => {
		await expect(
			assertFetchable('https://10.0.0.5/p.tgz', { ...base, insecure: true })
		).resolves.toBeUndefined();
	});

	it('refuses something that is not a url', async () => {
		await expect(assertFetchable('https://', base)).rejects.toThrow('is not a url');
	});
});

describe('probeRemote', () => {
	it('asks with HEAD before it spends the bandwidth', async () => {
		const ctx = ctxWith({ 'https://example.edu/p.tgz': ok('payload') });
		const source = await probeRemote(ctx, 'https://example.edu/p.tgz', base);
		expect(ctx.calls).toEqual([{ url: 'https://example.edu/p.tgz', method: 'HEAD' }]);
		expect(source.declared).toBe(7);
	});

	it('refuses a declared length over the ceiling without reading a byte of it', async () => {
		const ctx = ctxWith({
			'https://example.edu/p.tgz': new Response('', {
				headers: { 'content-length': '99999' }
			})
		});
		await expect(probeRemote(ctx, 'https://example.edu/p.tgz', base)).rejects.toThrow(
			'over the 1024 ceiling'
		);
	});

	it('follows a redirect and reports the hop it ended on', async () => {
		const ctx = ctxWith({
			'https://example.edu/p.tgz': new Response('', {
				status: 302,
				headers: { location: 'https://cdn.example.edu/p.tgz' }
			}),
			'https://cdn.example.edu/p.tgz': ok('payload')
		});
		const source = await probeRemote(ctx, 'https://example.edu/p.tgz', base);
		expect(source.url).toBe('https://cdn.example.edu/p.tgz');
		expect(source.hops).toEqual(['https://example.edu/p.tgz', 'https://cdn.example.edu/p.tgz']);
	});

	it('resolves a relative location against the hop it came from', async () => {
		const ctx = ctxWith({
			'https://example.edu/a/p.tgz': new Response('', {
				status: 301,
				headers: { location: '../b/p.tgz' }
			}),
			'https://example.edu/b/p.tgz': ok('payload')
		});
		expect((await probeRemote(ctx, 'https://example.edu/a/p.tgz', base)).url).toBe(
			'https://example.edu/b/p.tgz'
		);
	});

	it('checks every hop, so a public host cannot redirect into the private ranges', async () => {
		const ctx = ctxWith({
			'https://example.edu/p.tgz': new Response('', {
				status: 302,
				headers: { location: 'http://169.254.169.254/latest/meta-data/' }
			})
		});
		await expect(
			probeRemote(ctx, 'https://example.edu/p.tgz', {
				...base,
				resolve: (host) => (host === 'example.edu' ? publicly() : Promise.resolve([host]))
			})
		).rejects.toThrow('is plaintext');
	});

	it('refuses a chain longer than the hop ceiling', async () => {
		const loop = new Response('', {
			status: 302,
			headers: { location: 'https://example.edu/p.tgz' }
		});
		const ctx = ctxWith({ 'https://example.edu/p.tgz': () => loop.clone() });
		await expect(
			probeRemote(ctx, 'https://example.edu/p.tgz', { ...base, maxHops: 2 })
		).rejects.toThrow('redirects more than 2 times');
	});

	it('carries on when the server refuses HEAD, since many static hosts do', async () => {
		const ctx = ctxWith({
			'https://example.edu/p.tgz': new Response('', { status: 405 })
		});
		const source = await probeRemote(ctx, 'https://example.edu/p.tgz', base);
		expect(source.declared).toBe(-1);
	});

	it('reports the status when the url is simply not there', async () => {
		const ctx = ctxWith({});
		await expect(probeRemote(ctx, 'https://example.edu/p.tgz', base)).rejects.toThrow(
			'answered 404'
		);
	});
});

describe('fetchRemote', () => {
	it('returns the bytes and the digest of what actually arrived', async () => {
		const ctx = ctxWith({ 'https://example.edu/p.tgz': () => ok('payload') });
		const got = await fetchRemote(ctx, 'https://example.edu/p.tgz', base);
		expect(new TextDecoder().decode(got.bytes)).toBe('payload');
		// sha256('payload')
		expect(got.digest).toBe('239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5');
	});

	it('accepts a checksum that matches, in either spelling', async () => {
		const digest = '239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5';
		for (const checksum of [digest, `sha256:${digest}`, `SHA256:${digest.toUpperCase()}`]) {
			const ctx = ctxWith({ 'https://example.edu/p.tgz': () => ok('payload') });
			await expect(
				fetchRemote(ctx, 'https://example.edu/p.tgz', { ...base, checksum })
			).resolves.toBeTruthy();
		}
	});

	it('refuses a checksum that does not match', async () => {
		const ctx = ctxWith({ 'https://example.edu/p.tgz': () => ok('payload') });
		await expect(
			fetchRemote(ctx, 'https://example.edu/p.tgz', { ...base, checksum: 'sha256:beef' })
		).rejects.toThrow('hashes to sha256:239f59ed');
	});

	it('refuses a body over the ceiling even when the server declared it smaller', async () => {
		const ctx = ctxWith({
			'https://example.edu/p.tgz': () =>
				new Response('x'.repeat(4096), { headers: { 'content-length': '10' } })
		});
		await expect(
			fetchRemote(ctx, 'https://example.edu/p.tgz', { ...base, maxBytes: 16 })
		).rejects.toThrow('over the 16 byte ceiling');
	});

	it('downloads the hop the probe ended on rather than the url it started from', async () => {
		const ctx = ctxWith({
			'https://example.edu/p.tgz': () =>
				new Response('', { status: 302, headers: { location: 'https://cdn.edu/p.tgz' } }),
			'https://cdn.edu/p.tgz': () => ok('payload')
		});
		await fetchRemote(ctx, 'https://example.edu/p.tgz', base);
		expect(ctx.calls.at(-1)).toEqual({ url: 'https://cdn.edu/p.tgz', method: 'GET' });
	});
});

describe('bundleName', () => {
	it('takes the last segment', () => {
		expect(bundleName('https://example.edu/releases/payload-1.0.2.tar.gz')).toBe(
			'payload-1.0.2.tar.gz'
		);
	});

	it('refuses to climb out of the destination', () => {
		expect(bundleName('https://example.edu/..')).toBe('payload.tar.gz');
		expect(bundleName('https://example.edu/a/%2e%2e%2f%2e%2e%2fetc%2fpasswd')).toBe('passwd');
		expect(bundleName('https://example.edu/a%2fb%2f..%2fpayload.tgz')).toBe('payload.tgz');
	});

	it('keeps a name a malformed escape would otherwise throw on', () => {
		expect(bundleName('https://example.edu/payload%zz.tgz')).toBe('payloadzz.tgz');
	});

	it('names an unnamed download rather than writing to the directory itself', () => {
		expect(bundleName('https://example.edu/')).toBe('payload.tar.gz');
	});

	it('never produces a separator or a dotfile, whatever the url says', () => {
		for (const path of ['/%2e%2e%2f%2e%2e%2f', '/....%2f%2f', '/%2f%2f%2f', '/.ssh%2fid_rsa']) {
			const name = bundleName(`https://example.edu${path}`);
			expect(name, path).not.toContain('/');
			expect(name.startsWith('.'), path).toBe(false);
		}
	});
});

describe('pullBundle', () => {
	it('leaves a local path exactly as it was given', async () => {
		const ctx = ctxWith({});
		expect(await pullBundle(ctx, './payload.tar.gz', { dest: '/state/bundles/a' })).toEqual({
			path: './payload.tar.gz',
			digest: null
		});
		expect(ctx.calls).toEqual([]);
	});

	it('reads a file url as the path it names', async () => {
		const ctx = ctxWith({});
		expect(
			(await pullBundle(ctx, 'file:///srv/payload.tar.gz', { dest: '/state/bundles/a' })).path
		).toBe('/srv/payload.tar.gz');
	});

	it('downloads a url into the destination and reports where it landed', async () => {
		const ctx = ctxWith({ 'https://example.edu/payload.tar.gz': () => ok('payload') });
		const got = await pullBundle(ctx, 'https://example.edu/payload.tar.gz', {
			dest: '/state/bundles/a',
			resolve: publicly
		});
		expect(got.path).toBe('/state/bundles/a/payload.tar.gz');
		expect(ctx.files.readText(got.path)).toBe('payload');
		expect(got.digest).toHaveLength(64);
	});
});
