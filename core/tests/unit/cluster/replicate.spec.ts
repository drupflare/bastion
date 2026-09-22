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
	const fetcher = (async (input: string | URL | Request) => {
		urls.push(String(input));
		return answer(String(input));
	}) as unknown as typeof globalThis.fetch;
	return {
		ctx: { ...defaultContext(), fetch: fetcher, io: memoryIo(), env: {}, now: () => 0 },
		urls
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
		const { ctx, urls } = harness(() => new Response(withForm));
		const driver = new ReplicaDriver(ctx, 'owner-token');
		await driver.join('10.0.0.1:80', '10.0.0.2:80', 'www.example.edu', 1);
		expect(urls[0]).toContain('/user/login');
		expect(urls[1]).toContain('action=snapshot');
		expect(urls[2]).toContain('action=provision');
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

	it('carries the owner token and the site s Host on every call', async () => {
		const seen: Record<string, string>[] = [];
		const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
			seen.push((init?.headers ?? {}) as Record<string, string>);
			return new Response('{}');
		}) as unknown as typeof globalThis.fetch;
		const ctx = { ...defaultContext(), fetch: fetcher, io: memoryIo(), env: {}, now: () => 0 };
		await new ReplicaDriver(ctx, 'owner-token').snapshot('10.0.0.1:80', 'www.example.edu', 1);
		expect(seen[0]?.['x-cfw-owner-token']).toBe('owner-token');
		expect(seen[0]?.host).toBe('www.example.edu');
	});

	it('reports a refusal rather than raising', async () => {
		const { ctx } = harness(() => new Response('{"stage":"REFUSED"}', { status: 409 }));
		const result = await new ReplicaDriver(ctx, 't').status(
			'10.0.0.1:80',
			'www.example.edu',
			1
		);
		expect(result.ok).toBe(false);
		expect(result.stage).toBe('REFUSED');
	});
});
