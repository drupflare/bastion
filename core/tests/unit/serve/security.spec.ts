import { describe, expect, it } from 'vitest';
import {
	CSRF_HEADER,
	SESSION_COOKIE,
	checkCsrf,
	clearSessionCookie,
	constantTimeEqual,
	nonce,
	readCookie,
	securityHeaders,
	sessionCookie
} from '../../../src/serve/security';

describe('securityHeaders', () => {
	const headers = securityHeaders('NONCE', true);

	it('uses a nonce policy with strict-dynamic', () => {
		expect(headers['content-security-policy']).toContain(
			"script-src 'nonce-NONCE' 'strict-dynamic'"
		);
	});

	it('closes the two bypasses that make a nonce policy pointless', () => {
		expect(headers['content-security-policy']).toContain("object-src 'none'");
		expect(headers['content-security-policy']).toContain("base-uri 'none'");
	});

	it('refuses framing twice, for old browsers and new ones', () => {
		expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
		expect(headers['x-frame-options']).toBe('DENY');
	});

	it('sets nosniff and no-referrer', () => {
		expect(headers['x-content-type-options']).toBe('nosniff');
		expect(headers['referrer-policy']).toBe('no-referrer');
	});

	it('sets HSTS only on a secure listener', () => {
		expect(securityHeaders('N', false)['strict-transport-security']).toBeUndefined();
		expect(headers['strict-transport-security']).toContain('max-age=');
	});

	it('mints a fresh nonce each time', () => {
		expect(nonce()).not.toBe(nonce());
	});
});

describe('the session cookie', () => {
	it('uses the __Host- prefix, which fixes Path and forbids Domain', () => {
		expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
	});

	it('is HttpOnly, Secure, SameSite=Lax and rooted at /', () => {
		const cookie = sessionCookie('abc', 3600);
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('Secure');
		expect(cookie).toContain('SameSite=Lax');
		expect(cookie).toContain('Path=/');
		expect(cookie).not.toContain('Domain=');
	});

	it('clears by expiring rather than by deleting client-side', () => {
		expect(clearSessionCookie()).toContain('Max-Age=0');
	});

	it('reads one cookie out of a header carrying several', () => {
		expect(readCookie(`a=1; ${SESSION_COOKIE}=xyz; b=2`, SESSION_COOKIE)).toBe('xyz');
		expect(readCookie(null, SESSION_COOKIE)).toBe(null);
		expect(readCookie('a=1', SESSION_COOKIE)).toBe(null);
	});

	it('keeps a value containing an equals sign whole', () => {
		expect(readCookie('k=a=b', 'k')).toBe('a=b');
	});
});

describe('constantTimeEqual', () => {
	it('compares equal and unequal values', () => {
		expect(constantTimeEqual('abc', 'abc')).toBe(true);
		expect(constantTimeEqual('abc', 'abd')).toBe(false);
	});

	it('handles different lengths without raising', () => {
		expect(constantTimeEqual('a', 'abcdef')).toBe(false);
	});
});

describe('checkCsrf', () => {
	const origin = 'https://127.0.0.1:8787';
	const post = (headers: Record<string, string>) =>
		new Request(`${origin}/api/tenants`, { method: 'POST', headers });

	it('lets a read through without a token', () => {
		expect(checkCsrf(new Request(origin), 'T', origin).ok).toBe(true);
	});

	it('accepts a same-origin request carrying the matching token', () => {
		const request = post({ 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: 'T' });
		expect(checkCsrf(request, 'T', origin).ok).toBe(true);
	});

	it('refuses a cross-site request outright', () => {
		const request = post({ 'sec-fetch-site': 'cross-site', [CSRF_HEADER]: 'T' });
		expect(checkCsrf(request, 'T', origin)).toEqual({
			ok: false,
			reason: 'Sec-Fetch-Site is cross-site'
		});
	});

	it('falls back to Origin when Sec-Fetch-Site is missing', () => {
		const good = post({ origin, [CSRF_HEADER]: 'T' });
		expect(checkCsrf(good, 'T', origin).ok).toBe(true);
		const bad = post({ origin: 'https://evil.example', [CSRF_HEADER]: 'T' });
		expect(checkCsrf(bad, 'T', origin).ok).toBe(false);
	});

	it('refuses when neither header is present rather than assuming same origin', () => {
		expect(checkCsrf(post({ [CSRF_HEADER]: 'T' }), 'T', origin).ok).toBe(false);
	});

	it('refuses a same-origin request with no token, so SameSite alone is not the defence', () => {
		const request = post({ 'sec-fetch-site': 'same-origin' });
		expect(checkCsrf(request, 'T', origin)).toEqual({
			ok: false,
			reason: `no ${CSRF_HEADER} header`
		});
	});

	it('refuses a token that does not match the session', () => {
		const request = post({ 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: 'WRONG' });
		expect(checkCsrf(request, 'T', origin)).toEqual({
			ok: false,
			reason: 'the CSRF token does not match the session'
		});
	});

	it('refuses when there is no session at all', () => {
		const request = post({ 'sec-fetch-site': 'same-origin', [CSRF_HEADER]: 'T' });
		expect(checkCsrf(request, null, origin).ok).toBe(false);
	});
});
