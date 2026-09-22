import { describe, expect, it } from 'vitest';
import { REPLICA_LAG_MS, plan, planPromotion, promote } from '../../../src/cluster/placement';
import type { ClusterNode } from '../../../src/cluster/registry';

const node = (
	id: string,
	labels: Record<string, string> = {},
	state: ClusterNode['state'] = 'ready'
): ClusterNode => ({
	id,
	address: `${id}:8788`,
	serves: `${id}:80`,
	labels,
	state,
	lastSeenAt: 0,
	capacity: null,
	auditHead: null
});

describe('plan', () => {
	it('picks a primary and the requested number of replicas', () => {
		const placed = plan({
			site: 'www',
			tenant: 'acme',
			nodes: [node('a'), node('b'), node('c')],
			replicas: 2
		});
		expect(placed.primary).toBe('a');
		expect(placed.replicas).toHaveLength(2);
	});

	it('never puts a replica on the primary s own node', () => {
		const placed = plan({ site: 'www', tenant: 'acme', nodes: [node('a')], replicas: 2 });
		expect(placed.replicas).toEqual([]);
	});

	it('balances rather than stacking every site on one node', () => {
		const existing = [{ site: 'x', tenant: 't', primary: 'a', replicas: [] }];
		const placed = plan({
			site: 'www',
			tenant: 'acme',
			nodes: [node('a'), node('b')],
			existing
		});
		expect(placed.primary).toBe('b');
	});

	it('prefers a replica on a different rack, so the label buys diversity', () => {
		const placed = plan({
			site: 'www',
			tenant: 'acme',
			nodes: [node('a', { rack: '1' }), node('b', { rack: '1' }), node('c', { rack: '2' })],
			replicas: 1
		});
		expect(placed.replicas).toEqual(['c']);
	});

	it('ignores a node that is not ready', () => {
		const placed = plan({
			site: 'www',
			tenant: 'acme',
			nodes: [node('a', {}, 'draining'), node('b')],
			replicas: 1
		});
		expect(placed.primary).toBe('b');
	});

	it('honours a required label', () => {
		const placed = plan({
			site: 'www',
			tenant: 'acme',
			nodes: [node('a', { campus: 'north' }), node('b', { campus: 'south' })],
			require: { campus: 'south' }
		});
		expect(placed.primary).toBe('b');
	});

	it('refuses rather than placing on a node that does not satisfy the constraint', () => {
		expect(() =>
			plan({ site: 'www', tenant: 'acme', nodes: [node('a')], require: { campus: 'south' } })
		).toThrow(/no ready node/);
	});
});

describe('planPromotion', () => {
	const placement = { site: 'www', tenant: 'acme', primary: 'a', replicas: ['b'] };

	it('states the worst-case write loss BEFORE it acts', () => {
		const plan = planPromotion(placement, 'b', 1000, 6000);
		expect(plan.worstCaseLossMs).toBe(5000);
		expect(plan.warning).toContain('may not have reached b and will be lost');
	});

	it('assumes the full lag window when nothing is recorded', () => {
		const plan = planPromotion(placement, 'b', null, 6000);
		expect(plan.worstCaseLossMs).toBe(REPLICA_LAG_MS);
		expect(plan.warning).toContain('assume the full');
	});

	it('refuses to promote a node that holds no replica', () => {
		expect(() => planPromotion(placement, 'c', null, 0)).toThrow(/holds no replica/);
		expect(() => promote(placement, 'c')).toThrow(/holds no replica/);
	});
});

describe('promote', () => {
	it('swaps the primary and demotes the old one to a replica', () => {
		const placement = { site: 'www', tenant: 'acme', primary: 'a', replicas: ['b', 'c'] };
		expect(promote(placement, 'b')).toEqual({
			site: 'www',
			tenant: 'acme',
			primary: 'b',
			replicas: ['c', 'a']
		});
	});
});
