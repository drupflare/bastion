import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import {
	cloudflareProvider,
	dnsResponder,
	manualDnsResponder,
	publishSite,
	recordsFor,
	txtWatcher,
	type DnsRecord
} from '../../../src/domains/provider';
import { memoryIo } from '../../../src/io';

interface Call {
	url: string;
	method: string;
	body: string | null;
}

function harness(answer: (call: Call) => unknown, status = 200) {
	const calls: Call[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const call: Call = {
			url: String(input),
			method: init?.method ?? 'GET',
			body: typeof init?.body === 'string' ? init.body : null
		};
		calls.push(call);
		return new Response(
			JSON.stringify({
				success: status < 400,
				errors: status < 400 ? [] : [{ code: status, message: 'nope' }],
				result: answer(call)
			}),
			{ status }
		);
	}) as unknown as typeof globalThis.fetch;
	return {
		ctx: { ...defaultContext(), fetch: fetcher, io: memoryIo(), env: {}, now: () => 0 },
		calls
	};
}

const ZONES = [
	{ id: 'zone-outer', name: 'example.edu' },
	{ id: 'zone-inner', name: 'sites.example.edu' }
];

describe('cloudflareProvider', () => {
	it('picks the longest matching zone, so a delegated subdomain wins', async () => {
		const { ctx } = harness((call) => (call.url.includes('/zones?') ? ZONES : []));
		const provider = cloudflareProvider(ctx, { apiToken: 'T' });
		expect(await provider.zoneFor('alice.sites.example.edu')).toBe('zone-inner');
		expect(await provider.zoneFor('www.example.edu')).toBe('zone-outer');
	});

	it('answers null for a zone the token cannot see, rather than guessing', async () => {
		const { ctx } = harness((call) => (call.url.includes('/zones?') ? ZONES : []));
		expect(await cloudflareProvider(ctx, { apiToken: 'T' }).zoneFor('other.invalid')).toBe(
			null
		);
	});

	it('honours a zone allow list, so a broad token is narrowed by configuration', async () => {
		const { ctx } = harness((call) => (call.url.includes('/zones?') ? ZONES : []));
		const provider = cloudflareProvider(ctx, { apiToken: 'T', zones: ['sites.example.edu'] });
		expect(await provider.zoneFor('www.example.edu')).toBe(null);
		expect(await provider.zoneFor('alice.sites.example.edu')).toBe('zone-inner');
	});

	it('sends a scoped bearer token rather than a global key', async () => {
		const seen: Record<string, string>[] = [];
		const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
			seen.push((init?.headers ?? {}) as Record<string, string>);
			return new Response(JSON.stringify({ success: true, errors: [], result: ZONES }));
		}) as unknown as typeof globalThis.fetch;
		const ctx = { ...defaultContext(), fetch: fetcher, io: memoryIo(), env: {}, now: () => 0 };
		await cloudflareProvider(ctx, { apiToken: 'T' }).zoneFor('example.edu');
		expect(seen[0]?.authorization).toBe('Bearer T');
		expect(JSON.stringify(seen[0])).not.toContain('X-Auth-Key');
	});

	it('creates a record when none exists and updates when one does', async () => {
		const existing: { id: string; name: string; type: string; content: string; ttl: number }[] =
			[];
		const { ctx, calls } = harness((call) => {
			if (call.url.includes('/zones?')) return ZONES;
			if (call.method === 'GET') return existing;
			return { id: 'record-1' };
		});
		const provider = cloudflareProvider(ctx, { apiToken: 'T' });
		const record: DnsRecord = { name: 'a.example.edu', type: 'A', value: '203.0.113.10' };
		await provider.upsert('zone-outer', record);
		expect(calls.find((c) => c.method === 'POST')).toBeDefined();

		existing.push({
			id: 'record-1',
			name: 'a.example.edu',
			type: 'A',
			content: '203.0.113.10',
			ttl: 120
		});
		await provider.upsert('zone-outer', record);
		expect(calls.find((c) => c.method === 'PUT')?.url).toContain('record-1');
	});

	it('turns a 403 into a refusal that names the permission needed', async () => {
		const { ctx } = harness(() => null, 403);
		await expect(
			cloudflareProvider(ctx, { apiToken: 'T' }).zoneFor('example.edu')
		).rejects.toThrow(/cloudflare answered 403/);
	});

	it('marks a server error retryable and a permission error not', async () => {
		const server = harness(() => null, 502);
		await cloudflareProvider(server.ctx, { apiToken: 'T' })
			.zoneFor('example.edu')
			.catch((e: { retryable: boolean }) => expect(e.retryable).toBe(true));
		const denied = harness(() => null, 403);
		await cloudflareProvider(denied.ctx, { apiToken: 'T' })
			.zoneFor('example.edu')
			.catch((e: { retryable: boolean }) => expect(e.retryable).toBe(false));
	});

	it('removing a record that is not there is not an error', async () => {
		const { ctx } = harness((call) => (call.url.includes('/zones?') ? ZONES : []));
		await expect(
			cloudflareProvider(ctx, { apiToken: 'T' }).remove('zone-outer', {
				name: 'a.example.edu',
				type: 'A',
				value: '1.2.3.4'
			})
		).resolves.toBeUndefined();
	});
});

describe('recordsFor', () => {
	it('picks A for v4 and AAAA for v6', () => {
		const records = recordsFor('a.example.edu', ['203.0.113.10', '2001:db8::1']);
		expect(records.map((r) => r.type)).toEqual(['A', 'AAAA']);
	});

	it('publishes nothing for a node with no addresses', () => {
		expect(recordsFor('a.example.edu', [])).toEqual([]);
	});
});

describe('publishSite', () => {
	it('answers null when the provider does not host the zone, so the caller can fall back', async () => {
		const provider = {
			id: () => 'fake',
			zoneFor: async () => null,
			list: async () => [],
			upsert: async (_z: string, r: DnsRecord) => r,
			remove: async () => {}
		};
		expect(await publishSite(provider, 'a.invalid', ['203.0.113.10'])).toBe(null);
	});

	it('creates every record the name needs', async () => {
		const made: DnsRecord[] = [];
		const provider = {
			id: () => 'fake',
			zoneFor: async () => 'z',
			list: async () => [],
			upsert: async (_z: string, r: DnsRecord) => {
				made.push(r);
				return r;
			},
			remove: async () => {}
		};
		const result = await publishSite(provider, 'a.example.edu', [
			'203.0.113.10',
			'2001:db8::1'
		]);
		expect(result?.records).toHaveLength(2);
		expect(made.map((r) => r.type)).toEqual(['A', 'AAAA']);
	});
});

describe('dnsResponder', () => {
	it('publishes the challenge under the name ACME reads', async () => {
		const made: DnsRecord[] = [];
		const provider = {
			id: () => 'fake',
			zoneFor: async () => 'z',
			list: async () => [],
			upsert: async (_z: string, r: DnsRecord) => {
				made.push(r);
				return r;
			},
			remove: async () => {}
		};
		const responder = dnsResponder(provider, { sleep: async () => {} });
		await responder.publish('www.example.edu', 'TOKEN', 'VALUE');
		expect(made[0]?.name).toBe('_acme-challenge.www.example.edu');
		expect(made[0]?.type).toBe('TXT');
	});

	it('removes what it created when the challenge is retracted', async () => {
		const removed: DnsRecord[] = [];
		const provider = {
			id: () => 'fake',
			zoneFor: async () => 'z',
			list: async () => [],
			upsert: async (_z: string, r: DnsRecord) => ({ ...r, id: 'r1' }),
			remove: async (_z: string, r: DnsRecord) => void removed.push(r)
		};
		const responder = dnsResponder(provider, { sleep: async () => {} });
		await responder.publish('www.example.edu', 'TOKEN', 'VALUE');
		await responder.retract('www.example.edu', 'TOKEN');
		expect(removed[0]?.id).toBe('r1');
	});

	it('refuses by name when the provider does not host the zone', async () => {
		const provider = {
			id: () => 'fake',
			zoneFor: async () => null,
			list: async () => [],
			upsert: async (_z: string, r: DnsRecord) => r,
			remove: async () => {}
		};
		await expect(
			dnsResponder(provider, { sleep: async () => {} }).publish('a.invalid', 'T', 'V')
		).rejects.toThrow(/does not host a zone/);
	});
});

describe('manualDnsResponder', () => {
	it('tells the operator what to publish and waits for it', async () => {
		const announced: DnsRecord[] = [];
		const responder = manualDnsResponder({
			announce: (record) => void announced.push(record),
			confirm: async () => true
		});
		await responder.publish('www.example.edu', 'TOKEN', 'VALUE');
		expect(announced[0]?.name).toBe('_acme-challenge.www.example.edu');
		expect(announced[0]?.value).toBe('VALUE');
	});

	it('refuses without claiming the order when the record never appears', async () => {
		const responder = manualDnsResponder({ announce: () => {}, confirm: async () => false });
		await expect(responder.publish('www.example.edu', 'T', 'V')).rejects.toThrow(
			/no rate limit was spent/
		);
	});

	it('does not delete a record the operator maintains by hand', async () => {
		const responder = manualDnsResponder({ announce: () => {}, confirm: async () => true });
		await responder.publish('www.example.edu', 'T', 'V');
		await expect(responder.retract('www.example.edu', 'T')).resolves.toBeUndefined();
	});
});

describe('txtWatcher', () => {
	it('returns true once the value appears', async () => {
		let attempts = 0;
		const watch = txtWatcher(async () => (++attempts >= 3 ? ['VALUE'] : []), {
			attempts: 5,
			sleep: async () => {}
		});
		expect(await watch({ name: 'n', type: 'TXT', value: 'VALUE' })).toBe(true);
	});

	it('gives up rather than waiting forever', async () => {
		const watch = txtWatcher(async () => [], { attempts: 3, sleep: async () => {} });
		expect(await watch({ name: 'n', type: 'TXT', value: 'VALUE' })).toBe(false);
	});

	it('survives a resolver that throws', async () => {
		const watch = txtWatcher(async () => Promise.reject(new Error('down')), {
			attempts: 2,
			sleep: async () => {}
		});
		expect(await watch({ name: 'n', type: 'TXT', value: 'V' })).toBe(false);
	});
});
