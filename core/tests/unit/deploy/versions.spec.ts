import { describe, expect, it } from 'vitest';
import { VersionStore, pickVersion, versionId } from '../../../src/deploy/versions';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('versionId', () => {
	it('is the content address, so two identical uploads are one version', () => {
		expect(versionId(bytes('a'))).toBe(versionId(bytes('a')));
		expect(versionId(bytes('a'))).not.toBe(versionId(bytes('b')));
	});
});

describe('VersionStore', () => {
	it('does not create a second version for identical bytes', () => {
		const store = new VersionStore();
		store.add('www', bytes('v1'), 'op', 1);
		store.add('www', bytes('v1'), 'op', 2);
		expect(store.list('www')).toHaveLength(1);
	});

	it('keeps versions per site', () => {
		const store = new VersionStore();
		store.add('www', bytes('v1'), 'op', 1);
		store.add('lab', bytes('v1'), 'op', 1);
		expect(store.list('www')).toHaveLength(1);
		expect(store.list('lab')).toHaveLength(1);
	});

	it('refuses to deploy a version that was never uploaded', () => {
		expect(() => new VersionStore().deploy('www', 'nope', 'op', 1)).toThrow(/no version/);
	});

	it('moves a pointer rather than re-uploading', () => {
		const store = new VersionStore();
		const first = store.add('www', bytes('v1'), 'op', 1);
		const second = store.add('www', bytes('v2'), 'op', 2);
		store.deploy('www', first.id, 'op', 3);
		store.deploy('www', second.id, 'op', 4);
		expect(store.deployment('www')?.current).toBe(second.id);
	});

	it('rolls back to the version before the current one', () => {
		const store = new VersionStore();
		const first = store.add('www', bytes('v1'), 'op', 1);
		const second = store.add('www', bytes('v2'), 'op', 2);
		store.deploy('www', first.id, 'op', 3);
		store.deploy('www', second.id, 'op', 4);
		expect(store.rollback('www', 'op', 5).current).toBe(first.id);
	});

	it('refuses a rollback when there is nothing behind the current version', () => {
		const store = new VersionStore();
		const first = store.add('www', bytes('v1'), 'op', 1);
		store.deploy('www', first.id, 'op', 2);
		expect(() => store.rollback('www', 'op', 3)).toThrow(/nothing to roll back to/);
	});

	it('rolls back to a named version', () => {
		const store = new VersionStore();
		const first = store.add('www', bytes('v1'), 'op', 1);
		const second = store.add('www', bytes('v2'), 'op', 2);
		store.deploy('www', second.id, 'op', 3);
		expect(store.rollback('www', 'op', 4, first.id).current).toBe(first.id);
	});

	it('refuses a percentage outside the range', () => {
		const store = new VersionStore();
		const first = store.add('www', bytes('v1'), 'op', 1);
		store.deploy('www', first.id, 'op', 2);
		expect(() => store.rollout('www', first.id, 101, 'op', 3)).toThrow(/not a percentage/);
		expect(() => store.rollout('www', first.id, -1, 'op', 3)).toThrow(/not a percentage/);
	});

	it('refuses a rollout before anything is deployed', () => {
		const store = new VersionStore();
		const first = store.add('www', bytes('v1'), 'op', 1);
		expect(() => store.rollout('www', first.id, 10, 'op', 2)).toThrow(/nothing deployed/);
	});

	it('clears the split at zero percent rather than keeping an inert one', () => {
		const store = new VersionStore();
		const first = store.add('www', bytes('v1'), 'op', 1);
		const second = store.add('www', bytes('v2'), 'op', 2);
		store.deploy('www', first.id, 'op', 3);
		store.rollout('www', second.id, 50, 'op', 4);
		expect(store.deployment('www')?.split).not.toBe(null);
		store.rollout('www', second.id, 0, 'op', 5);
		expect(store.deployment('www')?.split).toBe(null);
	});

	it('keeps a deployment history', () => {
		const store = new VersionStore();
		const first = store.add('www', bytes('v1'), 'op', 1);
		store.deploy('www', first.id, 'op', 2);
		store.deploy('www', first.id, 'op', 3);
		expect(store.historyFor('www')).toHaveLength(2);
	});
});

describe('pickVersion', () => {
	const deployment = { site: 'www', current: 'A', split: null, at: 0, by: 'op' };

	it('sends everything to the current version with no split', () => {
		expect(pickVersion(deployment, 'anything')).toBe('A');
	});

	it('keeps one visitor on one side for the whole of a session', () => {
		const split = { ...deployment, split: { version: 'B', percent: 50 } };
		const first = pickVersion(split, 'visitor-1');
		for (let i = 0; i < 20; i++) expect(pickVersion(split, 'visitor-1')).toBe(first);
	});

	it('splits roughly at the percentage across many keys', () => {
		const split = { ...deployment, split: { version: 'B', percent: 30 } };
		let onB = 0;
		for (let i = 0; i < 2000; i++) if (pickVersion(split, `visitor-${i}`) === 'B') onB++;
		expect(onB / 2000).toBeGreaterThan(0.2);
		expect(onB / 2000).toBeLessThan(0.4);
	});

	it('sends everything to the canary at a hundred percent', () => {
		const split = { ...deployment, split: { version: 'B', percent: 100 } };
		for (let i = 0; i < 50; i++) expect(pickVersion(split, `v${i}`)).toBe('B');
	});
});
