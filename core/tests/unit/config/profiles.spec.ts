import { describe, expect, it } from 'vitest';
import { GENERIC_PROFILE, PROBE_PROFILES, probeProfile } from '../../../src/config/profiles';

/**
 * The seam that is supposed to hold all CMS knowledge, tested as the boundary it claims to be.
 *
 * `site probe` used to read `x-cfw-php-booted` from a string in the command, so the only bundle it
 * could prove a boot for was drupflare's and every other site read as broken.
 */
describe('probeProfile', () => {
	it('answers the generic profile for a site that names none', () => {
		expect(probeProfile()).toBe(GENERIC_PROFILE);
	});

	it('answers the generic profile for a name nobody has written yet', () => {
		expect(probeProfile('wordpress')).toBe(GENERIC_PROFILE);
	});

	it('carries drupflare boot header, which is the only place it is written down', () => {
		expect(probeProfile('drupflare').bootHeader).toBe('x-cfw-php-booted');
	});

	it('claims no boot header for a worker that is not a CMS', () => {
		expect(GENERIC_PROFILE.bootHeader).toBeNull();
	});

	it('gives every profile an ignore file, since the assets adapter always needs one', () => {
		for (const profile of Object.values(PROBE_PROFILES)) {
			expect(profile.ignoreFile).not.toBe('');
		}
	});
});
