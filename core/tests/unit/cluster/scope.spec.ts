import { describe, expect, it } from 'vitest';
import {
	KEY_SCOPES,
	assertChildMaySet,
	evaluateOffer,
	scopeOf,
	type ChildCapability
} from '../../../src/cluster/scope';

const able: ChildCapability = {
	modes: ['solo', 'hardened', 'isolated'],
	memoryBytes: 8 * 1024 ** 3,
	maxSites: 40,
	backupTargets: ['s3', 'fs']
};

describe('scopeOf', () => {
	it('puts the security posture under the control node', () => {
		for (const key of [
			'mode',
			'runtime.limits',
			'runtime.floors',
			'tenants',
			'audit.profile'
		]) {
			expect(scopeOf(key)).toBe('cluster');
		}
	});

	it('leaves a box s own hardware to the box', () => {
		for (const key of ['listeners', 'state', 'front.rateLimit', 'drivers.cache']) {
			expect(scopeOf(key)).toBe('node');
		}
	});

	it('negotiates the two that depend on what a node can actually do', () => {
		expect(scopeOf('runtime.residency')).toBe('negotiated');
		expect(scopeOf('backup.target')).toBe('negotiated');
	});

	it('falls back to node scope for a key it does not know, which is the safe default', () => {
		expect(scopeOf('something.new')).toBe('node');
	});

	it('resolves a nested key through its root', () => {
		expect(scopeOf('front.compression.minBytes')).toBe('node');
		expect(KEY_SCOPES.mode).toBe('cluster');
	});
});

describe('assertChildMaySet', () => {
	it('refuses a child setting a cluster-wide key, naming why', () => {
		expect(() => assertChildMaySet('mode')).toThrow(/weakest node its real posture/);
	});

	it('allows a child setting its own listeners', () => {
		expect(() => assertChildMaySet('listeners')).not.toThrow();
	});
});

describe('evaluateOffer', () => {
	it('accepts an offer the node can satisfy', () => {
		const outcome = evaluateOffer({ cluster: { mode: 'isolated' }, proposed: {} }, able);
		expect(outcome.accepted).toBe(true);
		expect(outcome.refused).toEqual([]);
	});

	it('refuses to join rather than joining degraded, and says which key', () => {
		const limited: ChildCapability = { ...able, modes: ['solo'] };
		const outcome = evaluateOffer({ cluster: { mode: 'isolated' }, proposed: {} }, limited);
		expect(outcome.accepted).toBe(false);
		expect(outcome.refused[0]?.key).toBe('mode');
		expect(outcome.refused[0]?.reason).toContain('cannot run `isolated`');
	});

	it('counters a negotiated key rather than refusing the whole join', () => {
		const tiny: ChildCapability = { ...able, maxSites: 0 };
		const outcome = evaluateOffer(
			{ cluster: {}, proposed: { 'runtime.residency': 'pin' } },
			tiny
		);
		expect(outcome.accepted).toBe(true);
		expect(outcome.countered['runtime.residency']).toBe('evict');
	});

	it('counters a backup target it cannot reach', () => {
		const outcome = evaluateOffer(
			{ cluster: {}, proposed: { 'backup.target': 'azure' } },
			able
		);
		expect(outcome.countered['backup.target']).toBe('s3');
	});

	it('passes a negotiated key through when the node can satisfy it', () => {
		const outcome = evaluateOffer({ cluster: {}, proposed: { 'backup.target': 's3' } }, able);
		expect(outcome.countered['backup.target']).toBe('s3');
	});
});
