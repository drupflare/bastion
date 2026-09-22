import { describe, expect, it } from 'vitest';
import {
	ReplicaDriver,
	assertSameCookieName,
	sessionCookieName
} from '../../../src/cluster/replicate';
import { defaultContext } from '../../../src/context';
import { memoryIo } from '../../../src/io';

function harness(answer: (url: string) => Response) {
	const urls: string[] = [];
	const bodies: Record<string, unknown>[] = [];
	const headers: Record<string, string>[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		urls.push(String(input));
		headers.push((init?.headers ?? {}) as Record<string, string>);
		if (init?.body !== undefined) {
			bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
		}
		return answer(String(input));
	}) as unknown as typeof globalThis.fetch;
	return {
		ctx: { ...defaultContext(), fetch: fetcher, io: memoryIo(), env: {}, now: () => 0 },
		urls,
		bodies,
		headers
	};
}

const withForm = '<form><input name="form_build_id" value="x"></form>';

describe('the session cookie name', () => {
	it('is the same on two nodes forwarding the same host', () => {
		expect(sessionCookieName('www.example.edu')).toBe(sessionCookieName('www.example.edu'));
	});

	it('differs for a different host, which is the defect that made every visitor anonymous', () => {
		expect(sessionCookieName('www.example.edu')).not.toBe(sessionCookieName('arm.invalid'));
	});

	it('ignores case, because a Host header may arrive in any', () => {
		expect(sessionCookieName('WWW.Example.EDU')).toBe(sessionCookieName('www.example.edu'));
	});

	it('refuses two nodes forwarding different hosts, naming the consequence', () => {
		expect(() => assertSameCookieName('www.example.edu', 'www.example.edu')).not.toThrow();
		expect(() => assertSameCookieName('www.example.edu', 'arm.invalid')).toThrow(
			/renders every visitor anonymous/
		);
	});
});

describe('ReplicaDriver', () => {
	it('renders a form-bearing page BEFORE provisioning, which is what mints the private key', async () => {
		const { ctx, urls, bodies } = harness(() => new Response(withForm));
		const driver = new ReplicaDriver(ctx, 'owner-token', 'bsn_node');
		await driver.join('10.0.0.1:80', '10.0.0.2:80', 'www.example.edu', 1);
		expect(urls[0]).toContain('/user/login');
		expect(bodies[0]?.action).toBe('snapshot');
		expect(bodies[1]?.action).toBe('provision');
	});

	it('stops before provisioning when the key has not been minted, and says so', async () => {
		const { ctx, urls } = harness(() => new Response('<p>no form here</p>'));
		const driver = new ReplicaDriver(ctx, 'owner-token');
		const steps = await driver.join('10.0.0.1:80', '10.0.0.2:80', 'www.example.edu', 1);
		expect(steps).toHaveLength(1);
		expect(steps[0]?.stage).toBe('key-missing');
		expect(steps[0]?.detail).toContain('rather than for a capacity one');
		expect(urls).toHaveLength(1);
	});

	/**
	 * Two credentials, and they are not interchangeable.
	 *
	 * The NODE credential gets the caller as far as the cluster endpoint; the SITE's owner token is
	 * what its own `/replica` route checks. Going through the site's front door instead would not
	 * work at all: `/replica` is on the diagnostic deny list for every tenant, and opening it for
	 * node traffic would open it for site traffic too.
	 */
	it('reaches the cluster endpoint with a node credential, carrying the owner token', async () => {
		const { ctx, urls, bodies, headers } = harness(() => new Response('{}'));
		await new ReplicaDriver(ctx, 'owner-token', 'bsn_node').snapshot(
			'10.0.0.1:8787',
			'www.example.edu',
			1
		);
		expect(urls[0]).toBe('http://10.0.0.1:8787/cluster/replica');
		expect(headers[0]?.authorization).toBe('Bearer bsn_node');
		expect(bodies[0]?.ownerToken).toBe('owner-token');
		expect(bodies[0]?.site).toBe('www.example.edu');
		expect(bodies[0]?.lane).toBe(1);
	});

	it('never dials the site front door, which refuses that route for every tenant', async () => {
		const { ctx, urls } = harness(() => new Response('{}'));
		await new ReplicaDriver(ctx, 'owner-token', 'bsn_node').status(
			'10.0.0.1:8787',
			'www.example.edu',
			1
		);
		expect(urls[0]).not.toContain('www.example.edu');
		expect(urls[0]).toContain('/cluster/replica');
	});

	it('reports a refusal rather than raising, carrying what the other node said', async () => {
		const { ctx } = harness(
			() =>
				new Response(
					JSON.stringify({ ok: false, error: { message: 'no such site here' } }),
					{
						status: 502
					}
				)
		);
		const result = await new ReplicaDriver(ctx, 't', 'bsn_node').status(
			'10.0.0.1:8787',
			'www.example.edu',
			1
		);
		expect(result.ok).toBe(false);
		expect(result.stage).toBe('failed');
		expect(result.detail).toBe('no such site here');
	});

	it('reports a node that answered without a credential', async () => {
		const { ctx } = harness(
			() =>
				new Response(
					JSON.stringify({ ok: false, error: { message: 'no node credential' } }),
					{ status: 401 }
				)
		);
		const result = await new ReplicaDriver(ctx, 't').status('10.0.0.1:8787', 'a.edu', 1);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain('no node credential');
	});
});
