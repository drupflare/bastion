import { randomBytes, timingSafeEqual } from 'node:crypto';

/** the cookie name; `__Host-` fixes Path=/, forbids Domain and requires Secure */
export const SESSION_COOKIE = '__Host-bastion-session';
export const CSRF_HEADER = 'x-bastion-csrf';

export function nonce(): string {
	return randomBytes(16).toString('base64');
}

/**
 * The response headers the management listener sets on every response.
 *
 * The nonce form of CSP rather than the hash form, because bastion serves the SPA from its own
 * process and so a per-request nonce is available; a flat-file deployment would need the
 * build-time hash instead. `strict-dynamic` lets the bundle load its own chunks without listing
 * each one, and `object-src 'none'` plus `base-uri 'none'` close the two bypasses that make a
 * nonce policy pointless.
 */
export function securityHeaders(scriptNonce: string, secure: boolean): Record<string, string> {
	return {
		'content-security-policy': [
			`script-src 'nonce-${scriptNonce}' 'strict-dynamic'`,
			"object-src 'none'",
			"base-uri 'none'",
			"frame-ancestors 'none'",
			"default-src 'self'",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data:",
			"connect-src 'self'"
		].join('; '),
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer',
		'x-frame-options': 'DENY',
		...(secure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {})
	};
}

export function sessionCookie(value: string, maxAgeSeconds: number): string {
	return [
		`${SESSION_COOKIE}=${value}`,
		'Path=/',
		'HttpOnly',
		'Secure',
		'SameSite=Lax',
		`Max-Age=${maxAgeSeconds}`
	].join('; ');
}

export function clearSessionCookie(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(header: string | null, name: string): string | null {
	if (header === null) return null;
	for (const part of header.split(';')) {
		const [key, ...rest] = part.trim().split('=');
		if (key === name) return rest.join('=');
	}
	return null;
}

/** compares two secrets without leaking their length difference through timing */
export function constantTimeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) {
		// still do a comparison so an early return does not itself time the length
		timingSafeEqual(left, left);
		return false;
	}
	return timingSafeEqual(left, right);
}

export type CsrfOutcome = { ok: true } | { ok: false; reason: string };

/**
 * The CSRF check: a synchronizer token, with `Sec-Fetch-Site` as the cheap first gate.
 *
 * The synchronizer token pattern because the dashboard is stateful, which is what OWASP says
 * stateful software should use. **`SameSite` is defence in depth and does not replace this.** The
 * `Origin`/`Host` comparison is the fallback for the one or two percent of requests that arrive
 * without `Sec-Fetch-Site`; if a double-submit cookie is ever used here it must be the HMAC-signed,
 * session-bound form, because the naive one carries an explicit OWASP warning.
 */
export function checkCsrf(
	request: Request,
	expectedToken: string | null,
	origin: string
): CsrfOutcome {
	const method = request.method.toUpperCase();
	if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return { ok: true };

	const site = request.headers.get('sec-fetch-site');
	if (site !== null && site !== 'same-origin' && site !== 'none') {
		return { ok: false, reason: `Sec-Fetch-Site is ${site}` };
	}
	if (site === null) {
		const sent = request.headers.get('origin');
		if (sent !== null && sent !== origin) {
			return { ok: false, reason: `Origin ${sent} is not ${origin}` };
		}
		if (sent === null)
			return { ok: false, reason: 'neither Sec-Fetch-Site nor Origin was sent' };
	}

	if (expectedToken === null)
		return { ok: false, reason: 'there is no session to check against' };
	const presented = request.headers.get(CSRF_HEADER);
	if (presented === null) return { ok: false, reason: `no ${CSRF_HEADER} header` };
	if (!constantTimeEqual(presented, expectedToken)) {
		return { ok: false, reason: 'the CSRF token does not match the session' };
	}
	return { ok: true };
}
