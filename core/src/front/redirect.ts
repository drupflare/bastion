import { normaliseHost } from './router';

export interface CanonicalPolicy {
	/** the name every alias redirects to, or null to serve each name as itself */
	canonical: string | null;
	aliases: string[];
	/** send http to https; off where bastion sits behind a terminating proxy */
	forceHttps?: boolean;
}

export interface RedirectOutcome {
	status: 301 | 308;
	location: string;
	reason: string;
}

/**
 * Whether a request should be redirected before it reaches a tenant.
 *
 * 308 rather than 301 for a scheme or host change, because 301 lets a client turn a POST into a
 * GET and a form submitted over http would arrive at https with its body dropped. The permanence
 * is the same; only the method preservation differs, and the method is the half that breaks
 * silently.
 *
 * The canonical redirect exists because two names serving identical content is two session cookie
 * scopes, two cache entries and two sets of search results. Picking one is a product decision an
 * operator makes per site, so `canonical: null` serves every alias as itself and is a supported
 * answer rather than a missing configuration.
 */
export function redirectFor(
	url: URL,
	host: string,
	policy: CanonicalPolicy
): RedirectOutcome | null {
	const name = normaliseHost(host);
	const canonical = policy.canonical === null ? null : normaliseHost(policy.canonical);

	if (canonical !== null && name !== canonical) {
		const target = new URL(url.toString());
		target.host = policy.canonical as string;
		if (policy.forceHttps === true) target.protocol = 'https:';
		return {
			status: 308,
			location: target.toString(),
			reason: `${name} is an alias of ${canonical}`
		};
	}

	if (policy.forceHttps === true && url.protocol === 'http:') {
		const target = new URL(url.toString());
		target.protocol = 'https:';
		return { status: 308, location: target.toString(), reason: 'http is redirected to https' };
	}

	return null;
}

export function redirectResponse(outcome: RedirectOutcome): Response {
	return new Response(null, {
		status: outcome.status,
		headers: { location: outcome.location, 'cache-control': 'max-age=3600' }
	});
}
