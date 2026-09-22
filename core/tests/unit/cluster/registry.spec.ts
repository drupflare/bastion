import { describe, expect, it } from 'vitest';
import { NodeRegistry, UNREACHABLE_AFTER_MS } from '../../../src/cluster/registry';
import { defaultContext } from '../../../src/context';
import { memoryIo } from '../../../src/io';

let clock = 1000;
function registry() {
	return new NodeRegistry({ ...defaultContext(), io: memoryIo(), env: {}, now: () => clock });
}

describe('NodeRegistry', () => {
	it('admits a node and marks it ready', () => {
		const nodes = registry();
		expect(nodes.join('node-a', '10.0.0.1:8788')).toMatchObject({
			id: 'node-a',
			state: 'ready'
		});
	});

	it('keeps what a rejoining node already reported', () => {
		const nodes = registry();
		nodes.join('node-a', '10.0.0.1:8788');
		nodes.heartbeat('node-a', { capacity: { sites: 40, memoryBytes: 1 }, auditHead: 'abc' });
		nodes.join('node-a', '10.0.0.2:8788');
		expect(nodes.get('node-a')?.capacity?.sites).toBe(40);
		expect(nodes.get('node-a')?.auditHead).toBe('abc');
	});

	it('refuses a heartbeat from a node it never admitted', () => {
		expect(() => registry().heartbeat('ghost')).toThrow(/not in this cluster/);
	});

	it('marks a silent node unreachable without forgetting it', () => {
		const nodes = registry();
		nodes.join('node-a', '10.0.0.1:8788');
		clock += UNREACHABLE_AFTER_MS + 1;
		expect(nodes.sweep()).toEqual(['node-a']);
		expect(nodes.get('node-a')?.state).toBe('unreachable');
		expect(nodes.list()).toHaveLength(1);
		clock = 1000;
	});

	it('brings an unreachable node back on the next heartbeat', () => {
		const nodes = registry();
		nodes.join('node-a', '10.0.0.1:8788');
		clock += UNREACHABLE_AFTER_MS + 1;
		nodes.sweep();
		expect(nodes.heartbeat('node-a').state).toBe('ready');
		clock = 1000;
	});

	it('leaves a draining node alone during a sweep, because it is silent on purpose', () => {
		const nodes = registry();
		nodes.join('node-a', '10.0.0.1:8788');
		nodes.drain('node-a');
		clock += UNREACHABLE_AFTER_MS + 1;
		expect(nodes.sweep()).toEqual([]);
		expect(nodes.get('node-a')?.state).toBe('draining');
		clock = 1000;
	});

	it('offers only ready nodes for new work', () => {
		const nodes = registry();
		nodes.join('node-a', '1:1');
		nodes.join('node-b', '2:2');
		nodes.drain('node-b');
		expect(nodes.available().map((n) => n.id)).toEqual(['node-a']);
	});

	it('records the audit head per node, so a child rewriting history is detectable', () => {
		const nodes = registry();
		nodes.join('node-a', '1:1');
		nodes.heartbeat('node-a', { auditHead: 'head-1' });
		expect(nodes.auditHeads()).toEqual({ 'node-a': 'head-1' });
	});

	it('keeps a node that left in the list rather than dropping its placement silently', () => {
		const nodes = registry();
		nodes.join('node-a', '1:1');
		nodes.leave('node-a');
		expect(nodes.get('node-a')?.state).toBe('left');
		expect(nodes.available()).toEqual([]);
	});
});
