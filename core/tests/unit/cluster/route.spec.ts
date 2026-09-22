import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SPREAD_ROUTES, chooseNode, mustProxy } from '../../../src/cluster/route';

const base = {
	site: 'www.example.edu',
	localNode: 'node-b',
	primaryNode: 'node-a',
	replicaNodes: ['node-b'],
	pathname: '/serve',
	method: 'GET'
};

describe('chooseNode', () => {
	it('serves a read on the serving path from the local replica', () => {
		const decision = chooseNode({ ...base });
		expect(decision).toMatchObject({ node: 'node-b', role: 'replica' });
	});

	it('sends a write to the primary', () => {
		expect(chooseNode({ ...base, method: 'POST' }).node).toBe('node-a');
		expect(chooseNode({ ...base, method: 'DELETE' }).reason).toContain('is a write');
	});

	it('sends anything off the serving path to the primary', () => {
		expect(chooseNode({ ...base, pathname: '/export' }).node).toBe('node-a');
		expect(chooseNode({ ...base, pathname: '/replica' }).node).toBe('node-a');
	});

	it('pins to the primary when no pathname was given at all', () => {
		const { pathname, ...withoutPath } = base;
		void pathname;
		expect(chooseNode(withoutPath).reason).toContain('an unnamed route');
	});

	it('pins to the primary when this node holds no replica for the site', () => {
		expect(chooseNode({ ...base, replicaNodes: ['node-c'] }).node).toBe('node-a');
	});

	it('pins to the primary when the site has no replicas at all', () => {
		expect(chooseNode({ ...base, replicaNodes: [] }).reason).toContain('no replica nodes');
	});

	it('spreads only the serving path, as an allow-list of one', () => {
		expect([...SPREAD_ROUTES]).toEqual(['/serve']);
	});
});

describe('mustProxy', () => {
	it('is true only when the decision names another node', () => {
		expect(mustProxy({ node: 'node-a', role: 'primary', reason: '' }, 'node-b')).toBe(true);
		expect(mustProxy({ node: 'node-b', role: 'replica', reason: '' }, 'node-b')).toBe(false);
	});
});

/**
 * Reads the sibling's source rather than restating its rules, so the two cannot drift. Skips with a
 * reason when the sibling is not checked out beside this repo.
 */
const siblingPath = new URL('../../../../../worker/src/ops/replica-routing.ts', import.meta.url)
	.pathname;
const sibling = existsSync(siblingPath) ? readFileSync(siblingPath, 'utf8') : null;

describe.skipIf(sibling === null)('mirrors the worker', () => {
	it('spreads exactly the routes the worker spreads', () => {
		const declared =
			/SPREAD_ROUTES[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(sibling ?? '')?.[1] ?? '';
		const theirs = declared
			.split(',')
			.map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
			.filter((entry) => entry !== '');
		expect([...SPREAD_ROUTES].sort()).toEqual(theirs.sort());
	});

	it('still pins a session-less write, which is the defect that reads as a broken password', () => {
		expect(sibling).toContain('a write carrying no session may establish one');
	});
});
