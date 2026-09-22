import { describe, expect, it } from 'vitest';
import { groupNames, MAX_GROUP_DEPTH, resolve } from '../../../src/config/groups';
import type { BastionConfig, SiteConfig, TenantConfig } from '../../../src/config/types';

/**
 * Groups, and the one rule that keeps them from being decorative.
 *
 * A capability NARROWS on the way down and never widens. Without that, a delegated tenant-admin
 * editing their own block could grant back whatever the operator withdrew, and the capability
 * table would report `enforced` for something a tenant can switch on. That is the same defect
 * class as a tripwire wired to nothing, in the place it would cost the most.
 */
const config = (groups: BastionConfig['groups']): Pick<BastionConfig, 'groups'> => ({ groups });

const tenant = (over: Partial<TenantConfig> = {}): TenantConfig => ({
	name: 'acme',
	sites: [],
	...over
});

const site = (over: Partial<SiteConfig> = {}): SiteConfig => ({
	host: 'a.example.edu',
	bundle: './p',
	...over
});

describe('resolve', () => {
	it('answers the shipped defaults for a tenant naming no group', () => {
		const answer = resolve(config(undefined), tenant());
		expect(answer.capabilities.codegen).toBe(false);
		expect(answer.capabilities.images).toBe(true);
		expect(answer.chain).toEqual([]);
	});

	it('applies the group a tenant names', () => {
		const answer = resolve(
			config({ students: { capabilities: { images: false }, limits: { maxSites: 5 } } }),
			tenant({ group: 'students' })
		);
		expect(answer.capabilities.images).toBe(false);
		expect(answer.limits.maxSites).toBe(5);
		expect(answer.chain).toEqual(['students']);
	});

	it('lets the tenant override a value the group set', () => {
		const answer = resolve(
			config({ base: { limits: { maxSites: 5 } } }),
			tenant({ group: 'base', limits: { maxSites: 40 } })
		);
		expect(answer.limits.maxSites).toBe(40);
	});

	it('walks an extends chain outermost first', () => {
		const answer = resolve(
			config({
				campus: { capabilities: { codegen: false }, limits: { maxSites: 100 } },
				students: { extends: 'campus', limits: { maxSites: 5 } }
			}),
			tenant({ group: 'students' })
		);
		expect(answer.limits.maxSites).toBe(5);
		expect(answer.chain).toEqual(['campus', 'students']);
	});

	it('narrows a capability and never widens it', () => {
		const answer = resolve(
			config({ locked: { capabilities: { browser: false } } }),
			tenant({ group: 'locked', capabilities: { browser: true } })
		);
		expect(answer.capabilities.browser).toBe(false);
	});

	it('refuses to let a site widen what its tenant withdrew', () => {
		const answer = resolve(
			config(undefined),
			tenant({ capabilities: { images: false } }),
			site({ capabilities: { images: true } })
		);
		expect(answer.capabilities.images).toBe(false);
	});

	it('lets a site withdraw what its tenant allows', () => {
		const answer = resolve(
			config(undefined),
			tenant(),
			site({ capabilities: { browser: false } })
		);
		expect(answer.capabilities.browser).toBe(false);
	});

	it('intersects the extension catalogue rather than letting a tier add to it', () => {
		const answer = resolve(
			config({ curated: { capabilities: { extensions: ['curl', 'openssl'] } } }),
			tenant({ group: 'curated', capabilities: { extensions: ['curl', 'ffi'] } })
		);
		expect(answer.capabilities.extensions).toEqual(['curl']);
	});

	it('takes the site group after the tenant group, so the narrower one is last', () => {
		const answer = resolve(
			config({
				tier: { limits: { maxSites: 50 } },
				pinned: { capabilities: { ai: false } }
			}),
			tenant({ group: 'tier' }),
			site({ group: 'pinned' })
		);
		expect(answer.capabilities.ai).toBe(false);
		expect(answer.limits.maxSites).toBe(50);
		expect(answer.chain).toEqual(['tier', 'pinned']);
	});

	it('replaces the egress list rather than merging it, because an allow list is a whole policy', () => {
		const answer = resolve(
			config({ base: { egress: { allow: ['a:443'] } } }),
			tenant({ group: 'base', egress: { allow: ['b:443'] } })
		);
		expect(answer.egress.allow).toEqual(['b:443']);
	});

	it('ignores a group name that resolves to nothing rather than throwing', () => {
		expect(resolve(config({}), tenant({ group: 'absent' })).chain).toEqual([]);
	});
});

describe('groupNames', () => {
	it('stops at a cycle instead of looping', () => {
		const names = groupNames({ a: { extends: 'b' }, b: { extends: 'a' } }, 'a');
		expect(names.length).toBeLessThanOrEqual(MAX_GROUP_DEPTH);
	});

	it('answers empty for a name nothing defines', () => {
		expect(groupNames({}, 'nope')).toEqual([]);
	});

	it('answers empty when there are no groups at all', () => {
		expect(groupNames(undefined, 'anything')).toEqual([]);
	});
});
