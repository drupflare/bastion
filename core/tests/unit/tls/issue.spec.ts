import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/defaults';
import type { DnsProvider } from '../../../src/domains/provider';
import {
	acmeConfigured,
	assertIssuable,
	chooseStrategy,
	isLocalName,
	renewable
} from '../../../src/tls/issue';
import type { StoredCertificate } from '../../../src/tls/store';

const provider: DnsProvider = {
	id: () => 'cloudflare',
	zoneFor: async () => 'z',
	list: async () => [],
	upsert: async (_z, r) => r,
	remove: async () => {}
};

const base = { host: 'www.example.edu', acmeConfigured: true };

function stored(source: StoredCertificate['source']): StoredCertificate {
	return {
		hosts: ['www.example.edu'],
		certificatePem: '',
		privateKeyPem: '',
		issuedAt: 0,
		expiresAt: 0,
		source
	};
}

describe('isLocalName', () => {
	it('recognises the names no public CA will ever issue for', () => {
		for (const host of ['site.local', 'box.internal', 'a.test', 'bastion', 'x.localhost']) {
			expect(isLocalName(host), host).toBe(true);
		}
	});

	it('does not treat a public name as local', () => {
		expect(isLocalName('www.example.edu')).toBe(false);
	});
});

describe('chooseStrategy', () => {
	it('never replaces an imported chain', () => {
		const choice = chooseStrategy({ ...base, existing: stored('imported'), provider });
		expect(choice.strategy).toBe('imported');
		expect(choice.reason).toContain('never replaces one it did not issue');
	});

	it('uses HTTP-01 for an ordinary reachable name', () => {
		expect(chooseStrategy(base).strategy).toBe('acme-http-01');
	});

	it('uses DNS-01 for a wildcard when a provider hosts the zone', () => {
		expect(chooseStrategy({ ...base, host: '*.sites.example.edu', provider }).strategy).toBe(
			'acme-dns-01'
		);
	});

	it('falls back to a manual TXT for a wildcard with no provider, and says what to run', () => {
		const choice = chooseStrategy({ ...base, host: '*.sites.example.edu' });
		expect(choice.strategy).toBe('acme-dns-01-manual');
		expect(choice.needsOperator).toBe(true);
		expect(choice.instruction).toContain('bastion cert issue');
	});

	it('uses DNS-01 for a name that is not reachable over HTTP', () => {
		expect(chooseStrategy({ ...base, publiclyReachable: false, provider }).strategy).toBe(
			'acme-dns-01'
		);
	});

	it('signs a local name with the local CA where one exists', () => {
		expect(
			chooseStrategy({ ...base, host: 'site.local', localCaAvailable: true }).strategy
		).toBe('local-ca');
	});

	it('self-signs a local name with no CA, and says what a client has to do', () => {
		const choice = chooseStrategy({ ...base, host: 'site.local' });
		expect(choice.strategy).toBe('self-signed');
		expect(choice.instruction).toContain('bastion cert trust');
	});

	it('self-signs rather than failing when no ACME account is configured', () => {
		const choice = chooseStrategy({ ...base, acmeConfigured: false });
		expect(choice.strategy).toBe('self-signed');
		expect(choice.instruction).toContain('cert import');
	});

	it('prefers DNS-01 under the primary domain where a provider hosts it', () => {
		const choice = chooseStrategy({
			...base,
			host: 'alice.sites.example.edu',
			primary: { domain: 'sites.example.edu' },
			provider
		});
		expect(choice.strategy).toBe('acme-dns-01');
		expect(choice.reason).toContain('no HTTP challenge has to reach this node');
	});

	it('gives every choice a reason, so a dry run explains itself', () => {
		for (const input of [
			base,
			{ ...base, host: 'site.local' },
			{ ...base, acmeConfigured: false }
		]) {
			expect(chooseStrategy(input).reason.length).toBeGreaterThan(10);
		}
	});
});

describe('renewable', () => {
	it('refuses to auto-renew an imported chain, and says who renews it instead', () => {
		const verdict = renewable(stored('imported'));
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain('bastion cert import');
	});

	it('renews what it issued', () => {
		expect(renewable(stored('acme')).ok).toBe(true);
		expect(renewable(stored('local')).ok).toBe(true);
	});
});

describe('acmeConfigured', () => {
	it('is false with no tls block and true with an email', () => {
		expect(acmeConfigured(defaultConfig())).toBe(false);
		expect(
			acmeConfigured({ ...defaultConfig(), tls: { acme: { email: 'ops@example.edu' } } })
		).toBe(true);
	});

	it('is false for something that is not an address', () => {
		expect(acmeConfigured({ ...defaultConfig(), tls: { acme: { email: 'ops' } } })).toBe(false);
	});
});

describe('assertIssuable', () => {
	it('passes a choice bastion can complete alone', () => {
		expect(() => assertIssuable(chooseStrategy(base))).not.toThrow();
	});

	it('refuses one that needs a human, carrying the instruction as the next step', () => {
		try {
			assertIssuable(chooseStrategy({ ...base, host: '*.sites.example.edu' }));
			expect.unreachable('should have refused');
		} catch (e) {
			expect((e as { next: string }).next).toContain('bastion cert issue');
		}
	});
});
