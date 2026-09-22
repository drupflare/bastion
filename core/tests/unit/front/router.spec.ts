import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/defaults';
import type { BastionConfig } from '../../../src/config/types';
import {
	DIAGNOSTIC_ROUTES,
	isDiagnosticPath,
	normaliseHost,
	resolveRoute,
	routeTable
} from '../../../src/front/router';

function withTenants(): BastionConfig {
	const config = defaultConfig();
	config.tenants = [
		{
			name: 'acme',
			sites: [{ host: 'www.example.edu', bundle: './p.tar.gz', probe: 'drupflare' }]
		},
		{
			name: 'labs',
			sites: [
				{
					host: 'Lab.Example.edu',
					bundle: './p.tar.gz',
					probe: 'drupflare',
					primary: 'node-a',
					replicas: ['node-b']
				}
			],
			capabilities: { diagnosticRoutes: true }
		}
	];
	return config;
}

describe('normaliseHost', () => {
	it('strips the port and lowercases', () => {
		expect(normaliseHost('Example.EDU:8443')).toBe('example.edu');
		expect(normaliseHost('example.edu')).toBe('example.edu');
	});

	it('keeps a bracketed ipv6 literal whole', () => {
		expect(normaliseHost('[::1]:8443')).toBe('[::1]');
	});
});

describe('routeTable', () => {
	it('keys every site by its normalised host and carries its placement', () => {
		const table = routeTable(withTenants());
		expect([...table.byHost.keys()].sort()).toEqual(['lab.example.edu', 'www.example.edu']);
		expect(table.byHost.get('lab.example.edu')?.primary).toBe('node-a');
		expect(table.byHost.get('lab.example.edu')?.replicas).toEqual(['node-b']);
	});

	it('defaults every capability off for a tenant that names none', () => {
		const table = routeTable(withTenants());
		const route = table.byHost.get('www.example.edu');
		expect(route?.capabilities.codegen).toBe(false);
		expect(route?.capabilities.diagnosticRoutes).toBe(false);
	});
});

describe('resolveRoute', () => {
	const table = routeTable(withTenants());

	it('resolves a host to its tenant', () => {
		const outcome = resolveRoute(table, 'www.example.edu', '/node/1');
		expect(outcome.ok && outcome.route.tenant).toBe('acme');
	});

	it('refuses a request with no Host header rather than picking a site', () => {
		const outcome = resolveRoute(table, null, '/');
		expect(outcome).toMatchObject({ ok: false, status: 400 });
	});

	it('404s an unknown host rather than falling back to a default site', () => {
		const outcome = resolveRoute(table, 'other.example.edu', '/');
		expect(outcome).toMatchObject({ ok: false, status: 404 });
	});

	it.each(DIAGNOSTIC_ROUTES)('refuses %s for a tenant that has them off', (route) => {
		const outcome = resolveRoute(table, 'www.example.edu', route);
		expect(outcome.ok).toBe(false);
	});

	it('refuses a path UNDER a diagnostic route, not only the route itself', () => {
		expect(resolveRoute(table, 'www.example.edu', '/php/run').ok).toBe(false);
		expect(isDiagnosticPath('/php/run')).toBe(true);
	});

	it('does not refuse a path that merely starts with the same letters', () => {
		expect(isDiagnosticPath('/planning')).toBe(false);
		expect(resolveRoute(table, 'www.example.edu', '/planning').ok).toBe(true);
	});

	it('allows the diagnostic set for a tenant that turned it on', () => {
		expect(resolveRoute(table, 'lab.example.edu', '/php').ok).toBe(true);
	});

	it('refuses per tenant, so one tenant turning it on does not open another', () => {
		expect(resolveRoute(table, 'lab.example.edu', '/sql').ok).toBe(true);
		expect(resolveRoute(table, 'www.example.edu', '/sql').ok).toBe(false);
	});
});
