/**
 * The connecting-address rewrite.
 *
 * `CF-Connecting-IP` does not exist on a bare host, and three shipped readers in the drupflare
 * bundle depend on it: the owner-token failure budget keys on it, replica affinity spreads on it,
 * and Drupal's per-IP flood control reads it through `getClientIp()`. On Cloudflare the edge
 * OVERWRITES the header, which is what makes it trustworthy; here nothing does, so a client could
 * set it and defeat all three at once.
 *
 * So bastion overwrites it on every inbound request. Overwrites -- never appends, never passes
 * through.
 */
export const CLIENT_IP_HEADER = 'cf-connecting-ip';
export const FORWARDED_FOR = 'x-forwarded-for';

/** headers a client must never be able to set on the way in */
export const STRIPPED_INBOUND = [CLIENT_IP_HEADER, 'cf-ipcountry', 'cf-ray', 'cf-visitor'];

export interface TrustPolicy {
	/** CIDRs whose `X-Forwarded-For` is believed; empty means trust nobody */
	trustedProxies: string[];
}

function parseCidr(cidr: string): { bytes: number[]; bits: number } | null {
	const [addr, maskText] = cidr.split('/');
	if (addr === undefined) return null;
	const parts = addr.split('.').map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
		return null;
	const bits = maskText === undefined ? 32 : Number(maskText);
	if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
	return { bytes: parts as number[], bits };
}

export function inCidr(ip: string, cidr: string): boolean {
	const net = parseCidr(cidr);
	const addr = parseCidr(ip);
	if (net === null || addr === null) return false;
	let remaining = net.bits;
	for (let i = 0; i < 4; i++) {
		if (remaining <= 0) break;
		const width = Math.min(8, remaining);
		const mask = (0xff << (8 - width)) & 0xff;
		if (((net.bytes[i] ?? 0) & mask) !== ((addr.bytes[i] ?? 0) & mask)) return false;
		remaining -= width;
	}
	return true;
}

export function isTrusted(ip: string, policy: TrustPolicy): boolean {
	return policy.trustedProxies.some((cidr) => inCidr(ip, cidr));
}

/**
 * The address to attribute a request to.
 *
 * With no trusted proxies the peer address wins outright. With some, the rightmost entry in
 * `X-Forwarded-For` that is NOT itself a trusted proxy is the client -- walking from the right is
 * what makes it unspoofable, because a client can prepend entries but cannot remove the ones the
 * trusted hops appended.
 */
export function resolveClientIp(
	peer: string,
	headers: Headers,
	policy: TrustPolicy = { trustedProxies: [] }
): string {
	if (policy.trustedProxies.length === 0 || !isTrusted(peer, policy)) return peer;
	const forwarded = headers.get(FORWARDED_FOR);
	if (forwarded === null) return peer;
	const hops = forwarded
		.split(',')
		.map((h) => h.trim())
		.filter((h) => h !== '');
	for (let i = hops.length - 1; i >= 0; i--) {
		const hop = hops[i] as string;
		if (!isTrusted(hop, policy)) return hop;
	}
	return peer;
}

/**
 * Rewrites an inbound request's headers before it reaches workerd.
 *
 * Returns a new Headers rather than mutating, so a caller cannot forget which one is sanitised.
 */
export function sanitiseInbound(
	headers: Headers,
	peer: string,
	policy: TrustPolicy = { trustedProxies: [] }
): Headers {
	const client = resolveClientIp(peer, headers, policy);
	const out = new Headers(headers);
	for (const name of STRIPPED_INBOUND) out.delete(name);
	if (policy.trustedProxies.length === 0) out.delete(FORWARDED_FOR);
	out.set(CLIENT_IP_HEADER, client);
	return out;
}
