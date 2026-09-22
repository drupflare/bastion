/**
 * The one place a CMS is named.
 *
 * Everything else in core is shaped by the config rather than by a product: the generator takes
 * binding names, the front door takes routes, the adapters take drivers. What genuinely differs
 * per CMS is the file it ships to mark assets private and the header it sets once it has booted,
 * so those two live here together and nothing reads either one from a hardcoded string.
 *
 * A site with no `probe` gets {@link GENERIC_PROFILE}: an arbitrary worker ships no ignore file
 * and sets no boot header, and asking it for one would fail a site that is working.
 */
export interface ProbeProfile {
	/** the ignore file the bundle ships beside its assets */
	ignoreFile: string;
	/** the response header that proves the runtime booted, or null where the bundle sets none */
	bootHeader: string | null;
}

export const GENERIC_PROFILE: ProbeProfile = { ignoreFile: '.assetsignore', bootHeader: null };

export const PROBE_PROFILES: Record<string, ProbeProfile> = {
	drupflare: { ignoreFile: '.assetsignore', bootHeader: 'x-cfw-php-booted' },
	generic: GENERIC_PROFILE
};

/** an unknown name is not a failure; it is a bundle whose profile nobody has written yet */
export function probeProfile(name?: string): ProbeProfile {
	if (name === undefined) return GENERIC_PROFILE;
	return PROBE_PROFILES[name] ?? GENERIC_PROFILE;
}
