import { CLIENT_IP_HEADER, STRIPPED_INBOUND } from './client-ip';

/**
 * Response headers a site may never set for itself.
 *
 * Two classes. The first is anything the front door owns because a tenant setting it would undo a
 * decision made for every tenant: the transport security policy, the framing refusal on the
 * management origin, and the content type sniffing rule. The second is anything that would let one
 * site claim another's identity or cache entry.
 *
 * A tenant that sets one of these does not get a silent override; the write is refused so the
 * operator finds out at configuration time rather than from a penetration test.
 */
export const RESERVED_RESPONSE_HEADERS = new Set([
	'strict-transport-security',
	'content-security-policy-report-only',
	'x-content-type-options',
	'transfer-encoding',
	'content-length',
	'connection',
	'keep-alive',
	'upgrade',
	'set-cookie'
]);

/**
 * Request headers a site may never inject.
 *
 * `CF-Connecting-IP` is the load-bearing one and the reason this list exists at all: three shipped
 * readers in the site bundle key on it, the front door overwrites it from the peer, and a custom
 * header that could set it would hand the site back the spoofing it was written to remove.
 */
export const RESERVED_REQUEST_HEADERS = new Set([...STRIPPED_INBOUND, CLIENT_IP_HEADER, 'host']);

export interface HeaderRule {
	/** the path prefix this applies to; `/` is everything */
	path: string;
	set?: Record<string, string>;
	remove?: string[];
}

export interface HeaderPolicy {
	request?: HeaderRule[];
	response?: HeaderRule[];
}

export interface HeaderProblem {
	where: 'request' | 'response';
	header: string;
	reason: string;
}

/** a header value that would split the response or inject a second one */
function unsafeValue(value: string): boolean {
	return /[\r\n\0]/.test(value);
}

/**
 * Checks a header policy at configuration time.
 *
 * Refusing here rather than dropping at serve time is the whole point: an operator who set a
 * header that is silently ignored believes it is set, and the first thing that tells them
 * otherwise is whatever the header was supposed to prevent.
 */
export function checkHeaderPolicy(policy: HeaderPolicy): HeaderProblem[] {
	const problems: HeaderProblem[] = [];
	const inspect = (where: 'request' | 'response', rules: HeaderRule[] | undefined): void => {
		const reserved = where === 'request' ? RESERVED_REQUEST_HEADERS : RESERVED_RESPONSE_HEADERS;
		for (const rule of rules ?? []) {
			for (const [name, value] of Object.entries(rule.set ?? {})) {
				const header = name.toLowerCase();
				if (reserved.has(header)) {
					problems.push({
						where,
						header,
						reason:
							where === 'request'
								? `${header} is set by the front door from the connection and cannot be overridden`
								: `${header} is owned by the front door and cannot be set per site`
					});
					continue;
				}
				if (unsafeValue(value)) {
					problems.push({ where, header, reason: 'the value contains a newline' });
				}
			}
			for (const name of rule.remove ?? []) {
				if (reserved.has(name.toLowerCase())) {
					problems.push({
						where,
						header: name.toLowerCase(),
						reason: `${name.toLowerCase()} cannot be removed`
					});
				}
			}
		}
	};
	inspect('request', policy.request);
	inspect('response', policy.response);
	return problems;
}

function matching(rules: HeaderRule[] | undefined, pathname: string): HeaderRule[] {
	return (rules ?? []).filter(
		(rule) =>
			rule.path === '/' || pathname === rule.path || pathname.startsWith(`${rule.path}/`)
	);
}

/**
 * Applies a checked policy.
 *
 * The reserved set is enforced again here rather than trusted from the configuration check,
 * because a policy can also arrive from the management API, and a rule enforced in one place is a
 * rule that holds only on the path someone remembered.
 */
export function applyHeaders(
	headers: Headers,
	policy: HeaderRule[] | undefined,
	pathname: string,
	where: 'request' | 'response'
): Headers {
	const reserved = where === 'request' ? RESERVED_REQUEST_HEADERS : RESERVED_RESPONSE_HEADERS;
	const out = new Headers(headers);
	for (const rule of matching(policy, pathname)) {
		for (const name of rule.remove ?? []) {
			if (!reserved.has(name.toLowerCase())) out.delete(name);
		}
		for (const [name, value] of Object.entries(rule.set ?? {})) {
			if (reserved.has(name.toLowerCase()) || unsafeValue(value)) continue;
			out.set(name, value);
		}
	}
	return out;
}

/** the headers bastion adds to every site response unless the site set its own */
export function defaultResponseHeaders(headers: Headers): Headers {
	const out = new Headers(headers);
	if (!out.has('x-content-type-options')) out.set('x-content-type-options', 'nosniff');
	return out;
}
