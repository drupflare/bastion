import { describe, expect, it } from 'vitest';
import { GRANTS, ROLES, authorize, can, tenantFor, type Principal } from '../../../src/api/authz';
import { ROUTES, pathParams, routeFor } from '../../../src/api/routes';

const operator: Principal = { id: 'op', role: 'operator', tenant: null, credential: 'session' };
const admin: Principal = { id: 'a', role: 'tenant-admin', tenant: 'acme', credential: 'session' };
const viewer: Principal = { id: 'v', role: 'tenant-viewer', tenant: 'acme', credential: 'token' };

describe('GRANTS', () => {
	it('gives only the operator anything that touches the host or another tenant', () => {
		for (const action of [
			'host.write',
			'config.write',
			'cluster.write',
			'secrets.read'
		] as const) {
			expect(GRANTS.operator).toContain(action);
			expect(GRANTS['tenant-admin']).not.toContain(action);
			expect(GRANTS['tenant-viewer']).not.toContain(action);
		}
	});

	it('makes the viewer read-only', () => {
		for (const action of GRANTS['tenant-viewer']) {
			expect(action.endsWith('.read')).toBe(true);
		}
	});

	it('has three roles and no more', () => {
		expect(ROLES).toEqual(['operator', 'tenant-admin', 'tenant-viewer']);
	});
});

describe('authorize', () => {
	it('lets an operator through', () => {
		expect(() => authorize({ principal: operator, action: 'host.write' })).not.toThrow();
	});

	it('refuses an action the role does not have', () => {
		expect(() => authorize({ principal: admin, action: 'config.write' })).toThrow(/may not/);
	});

	it('refuses a tenant credential reaching another tenant', () => {
		expect(() => authorize({ principal: admin, action: 'site.write', tenant: 'labs' })).toThrow(
			/scoped to acme/
		);
	});

	it('allows a tenant credential acting on its own tenant', () => {
		expect(() =>
			authorize({ principal: admin, action: 'site.write', tenant: 'acme' })
		).not.toThrow();
	});

	it('refuses a tenant credential carrying no tenant, rather than treating it as global', () => {
		const orphan: Principal = { ...admin, tenant: null };
		expect(() => authorize({ principal: orphan, action: 'site.read' })).toThrow(
			/reaches nothing/
		);
	});

	it('refuses a viewer trying to write', () => {
		expect(can(viewer, 'site.write', 'acme')).toBe(false);
		expect(can(viewer, 'site.read', 'acme')).toBe(true);
	});
});

describe('tenantFor', () => {
	it('takes a non-operator s tenant from the credential, never from the request', () => {
		expect(tenantFor(admin, 'labs')).toBe('acme');
		expect(tenantFor(viewer, 'anything')).toBe('acme');
	});

	it('lets an operator name one, because they already reach every tenant', () => {
		expect(tenantFor(operator, 'labs')).toBe('labs');
		expect(tenantFor(operator)).toBe(null);
	});
});

describe('the route table', () => {
	it('gives every route an action, so none can ship without a check', () => {
		for (const route of ROUTES) {
			expect(route.action).toBeTruthy();
			expect(GRANTS.operator).toContain(route.action);
		}
	});

	it('gives every route a CLI command, so the two surfaces cannot grow apart', () => {
		for (const route of ROUTES) expect(route.command.startsWith('bastion ')).toBe(true);
	});

	it('keeps API tokens off everything that changes the host or reads a secret', () => {
		for (const route of ROUTES) {
			if (!route.token) continue;
			expect([
				'config.write',
				'secrets.read',
				'secrets.write',
				'host.write',
				'cluster.write'
			]).not.toContain(route.action);
		}
	});

	it('matches a literal path and a parameterised one', () => {
		expect(routeFor('GET', '/api/status')?.action).toBe('host.read');
		expect(routeFor('POST', '/api/sites/www.example.edu/deploy')?.action).toBe('deploy');
	});

	it('does not match a path of a different length', () => {
		expect(routeFor('GET', '/api/status/extra')).toBe(null);
		expect(routeFor('DELETE', '/api/status')).toBe(null);
	});

	it('extracts path parameters, which authorization never reads', () => {
		const route = routeFor('POST', '/api/sites/www.example.edu/deploy');
		expect(pathParams(route!, '/api/sites/www.example.edu/deploy')).toEqual({
			site: 'www.example.edu'
		});
	});

	it('has no duplicate method and path pairs', () => {
		const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
