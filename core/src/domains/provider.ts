import type { Context } from '../context';
import { BastionError } from '../errors';
import type { ChallengeResponder } from '../tls/acme';

export interface DnsRecord {
	name: string;
	type: 'A' | 'AAAA' | 'CNAME' | 'TXT';
	value: string;
	ttl?: number;
	/** provider-assigned, so a delete does not have to search */
	id?: string;
}

/**
 * The shape a DNS provider has to satisfy.
 *
 * Structural and small, the way this repository states every other client contract: bastion brings
 * no provider SDK, so an operator on Route53 or PowerDNS writes four methods rather than waiting
 * for a driver. Everything above this interface is provider-independent, including the DNS-01
 * responder.
 */
export interface DnsProvider {
	id(): string;
	/** the zone that owns a name, or null when this provider does not host it */
	zoneFor(host: string): Promise<string | null>;
	list(zone: string, name: string, type: DnsRecord['type']): Promise<DnsRecord[]>;
	upsert(zone: string, record: DnsRecord): Promise<DnsRecord>;
	remove(zone: string, record: DnsRecord): Promise<void>;
}

export interface CloudflareOptions {
	apiToken: string;
	/** narrows which zones bastion may touch; empty means every zone the token can see */
	zones?: string[];
	base?: string;
}

interface CloudflareZone {
	id: string;
	name: string;
}

interface CloudflareEnvelope<T> {
	success: boolean;
	errors: { code: number; message: string }[];
	result: T;
}

/**
 * Cloudflare DNS, active only when a token is configured.
 *
 * A scoped token rather than a global key: the only permission bastion needs is Zone.DNS edit on
 * the zones it manages, and asking for a global key to write one TXT record is asking for the
 * account. When the token cannot see a zone, `zoneFor` answers null and the caller falls back to
 * telling the operator which record to publish by hand, which is what happens with no provider at
 * all.
 */
export function cloudflareProvider(ctx: Context, options: CloudflareOptions): DnsProvider {
	const base = options.base ?? 'https://api.cloudflare.com/client/v4';
	let zones: CloudflareZone[] | null = null;

	const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
		const response = await ctx.fetch(`${base}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${options.apiToken}`,
				'content-type': 'application/json',
				...((init.headers ?? {}) as Record<string, string>)
			}
		});
		const body = (await response.json().catch(() => ({
			success: false,
			errors: [{ code: response.status, message: response.statusText }],
			result: null
		}))) as CloudflareEnvelope<T>;
		if (!response.ok || body.success !== true) {
			const reason =
				body.errors?.map((error) => error.message).join('; ') ?? response.statusText;
			throw new BastionError(
				response.status === 403 ? 'capability-refused' : 'driver-unreachable',
				`cloudflare answered ${response.status}: ${reason}`,
				{
					retryable: response.status >= 500,
					next:
						response.status === 403
							? 'check the token has Zone.DNS edit on this zone'
							: null
				}
			);
		}
		return body.result;
	};

	const loadZones = async (): Promise<CloudflareZone[]> => {
		if (zones !== null) return zones;
		const all = await call<CloudflareZone[]>('/zones?per_page=50');
		zones =
			options.zones === undefined || options.zones.length === 0
				? all
				: all.filter((zone) => options.zones?.includes(zone.name));
		return zones;
	};

	return {
		id: () => 'cloudflare',

		zoneFor: async (host) => {
			const name = host.toLowerCase().replace(/\.$/, '');
			const available = await loadZones();
			// the longest matching suffix wins, so `a.b.example.edu` picks `b.example.edu` over
			// `example.edu` when both are on the account
			const match = available
				.filter((zone) => name === zone.name || name.endsWith(`.${zone.name}`))
				.sort((a, b) => b.name.length - a.name.length)[0];
			return match?.id ?? null;
		},

		list: async (zone, name, type) => {
			const query = new URLSearchParams({ name: name.toLowerCase(), type });
			const records = await call<
				{ id: string; name: string; type: string; content: string; ttl: number }[]
			>(`/zones/${zone}/dns_records?${query.toString()}`);
			return records.map((record) => ({
				id: record.id,
				name: record.name,
				type: record.type as DnsRecord['type'],
				value: record.content,
				ttl: record.ttl
			}));
		},

		upsert: async (zone, record) => {
			const existing = await cloudflareProvider(ctx, options).list(
				zone,
				record.name,
				record.type
			);
			const payload = JSON.stringify({
				type: record.type,
				name: record.name,
				content: record.value,
				ttl: record.ttl ?? 120,
				proxied: false
			});
			const current = existing.find((entry) => entry.value === record.value) ?? existing[0];
			const created = await call<{ id: string }>(
				current?.id === undefined
					? `/zones/${zone}/dns_records`
					: `/zones/${zone}/dns_records/${current.id}`,
				{ method: current?.id === undefined ? 'POST' : 'PUT', body: payload }
			);
			return { ...record, id: created.id };
		},

		remove: async (zone, record) => {
			const id =
				record.id ??
				(await cloudflareProvider(ctx, options).list(zone, record.name, record.type)).find(
					(entry) => entry.value === record.value
				)?.id;
			if (id === undefined) return;
			await call(`/zones/${zone}/dns_records/${id}`, { method: 'DELETE' });
		}
	};
}

/**
 * The DNS-01 responder, over whichever provider is configured.
 *
 * DNS-01 rather than HTTP-01 is what makes a wildcard possible at all, and it is the only challenge
 * that works for a name whose HTTP is not yet pointed here. Without a provider bastion falls back
 * to HTTP-01, because a manual TXT record that a human has to publish inside the challenge's
 * lifetime is not an automated renewal.
 */
export function dnsResponder(
	provider: DnsProvider,
	options: { waitMs?: number; sleep?(ms: number): Promise<void> } = {}
): ChallengeResponder {
	const published = new Map<string, { zone: string; record: DnsRecord }>();
	const wait = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	return {
		type: 'dns-01',
		publish: async (host, token, value) => {
			const zone = await provider.zoneFor(host);
			if (zone === null) {
				throw new BastionError(
					'capability-refused',
					`${provider.id()} does not host a zone for ${host}, so it cannot answer a DNS challenge`,
					{ next: `bastion domain verify ${host}` }
				);
			}
			const record: DnsRecord = {
				name: `_acme-challenge.${host.toLowerCase()}`,
				type: 'TXT',
				value,
				ttl: 60
			};
			published.set(token, { zone, record: await provider.upsert(zone, record) });
			// the CA reads this from a public resolver, not from the provider's API, so a pause
			// before claiming the challenge is what stops a validation against a stale answer
			await wait(options.waitMs ?? 10_000);
		},
		retract: async (_host, token) => {
			const entry = published.get(token);
			if (entry === undefined) return;
			await provider.remove(entry.zone, entry.record);
			published.delete(token);
		}
	};
}

/** records a site needs so its name reaches this node */
export function recordsFor(host: string, addresses: string[]): DnsRecord[] {
	return addresses.map((address) => ({
		name: host.toLowerCase(),
		type: address.includes(':') ? ('AAAA' as const) : ('A' as const),
		value: address,
		ttl: 300
	}));
}

/** creates every record a newly allocated name needs, where a provider hosts the zone */
export async function publishSite(
	provider: DnsProvider,
	host: string,
	addresses: string[]
): Promise<{ zone: string; records: DnsRecord[] } | null> {
	const zone = await provider.zoneFor(host);
	if (zone === null) return null;
	const records: DnsRecord[] = [];
	for (const record of recordsFor(host, addresses)) {
		records.push(await provider.upsert(zone, record));
	}
	return { zone, records };
}

export interface ManualResponderOptions {
	/** how the operator is told what to publish */
	announce(record: DnsRecord): void;
	/** resolves once the record is visible, or rejects when the wait runs out */
	confirm(record: DnsRecord): Promise<boolean>;
}

/**
 * DNS-01 with no provider, which is the path an operator on a DNS host bastion cannot drive takes.
 *
 * It exists because the alternative is worse in a specific way: without it, an operator who wants a
 * wildcard or who cannot expose HTTP starts an ACME order that fails inside the CA after the
 * challenge times out, with no message on this side saying what was expected. Here the record is
 * printed, the flow WAITS, and the operator is told exactly what to publish.
 *
 * This cannot be a scheduled renewal. A path that needs a human inside a challenge's lifetime is a
 * path that lapses the first time nobody is looking, so a certificate issued this way is reported
 * as needing attention well before it expires rather than silently retried.
 */
export function manualDnsResponder(options: ManualResponderOptions): ChallengeResponder {
	const published = new Map<string, DnsRecord>();
	return {
		type: 'dns-01',
		publish: async (host, token, value) => {
			const record: DnsRecord = {
				name: `_acme-challenge.${host.toLowerCase()}`,
				type: 'TXT',
				value,
				ttl: 60
			};
			options.announce(record);
			const visible = await options.confirm(record);
			if (!visible) {
				throw new BastionError(
					'capability-refused',
					`${record.name} did not appear with the expected value, so the order was not ` +
						'claimed. Nothing was asked of the CA, so no rate limit was spent',
					{ retryable: true, next: `bastion cert issue ${host}` }
				);
			}
			published.set(token, record);
		},
		retract: async (_host, token) => {
			// nothing to remove: bastion did not create the record and must not delete what an
			// operator maintains by hand. The record is theirs to clean up, and the instruction says so
			published.delete(token);
		}
	};
}

/** polls a resolver until the expected TXT value appears, or the deadline passes */
export function txtWatcher(
	resolve: (name: string) => Promise<string[]>,
	options: { attempts?: number; everyMs?: number; sleep?(ms: number): Promise<void> } = {}
) {
	const wait = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	return async (record: DnsRecord): Promise<boolean> => {
		for (let attempt = 0; attempt < (options.attempts ?? 60); attempt++) {
			const values = await resolve(record.name).catch(() => [] as string[]);
			if (values.includes(record.value)) return true;
			await wait(options.everyMs ?? 10_000);
		}
		return false;
	};
}
