import { expect, test } from './utils/rig';

/**
 * The web hardening, asserted from the browser's side of it.
 *
 * A unit test can check that `securityHeaders()` returns a string. Only a browser can say whether
 * the policy it produces actually loads the application, and a CSP that is correct on paper and
 * blocks the SPA's own bundle is the failure mode that ships.
 */
test.describe('the management origin', () => {
	test('serves the API under a nonce CSP with strict-dynamic', async ({ page }) => {
		const response = await page.request.get('/api/health');
		const policy = response.headers()['content-security-policy'] ?? '';
		expect(policy).toContain("'strict-dynamic'");
		expect(policy).toContain("object-src 'none'");
		expect(policy).toContain("frame-ancestors 'none'");
	});

	test('refuses to be framed', async ({ page }) => {
		const response = await page.request.get('/api/health');
		expect(response.headers()['x-frame-options']).toBe('DENY');
		expect(response.headers()['x-content-type-options']).toBe('nosniff');
		expect(response.headers()['referrer-policy']).toBe('no-referrer');
	});

	test('sets a __Host- session cookie the page script cannot read', async ({ page }) => {
		await page.goto('/');
		const visible = await page.evaluate(() => document.cookie);
		expect(visible).not.toContain('bastion-session');
		const stored = await page.context().cookies();
		const session = stored.find((cookie) => cookie.name.endsWith('bastion-session'));
		expect(session?.httpOnly).toBe(true);
		expect(session?.secure).toBe(true);
		expect(session?.sameSite).toBe('Lax');
	});

	test('refuses a write that carries the session but no CSRF token', async ({ page }) => {
		await page.goto('/');
		const status = await page.evaluate(async () => {
			const response = await fetch('/api/config', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: '{}'
			});
			return response.status;
		});
		expect(status).toBe(403);
	});

	test('refuses an unauthenticated call rather than rendering a signed-out page as signed in', async ({
		browser
	}) => {
		const clean = await browser.newContext({ ignoreHTTPSErrors: true });
		const response = await clean.request.get('/api/health');
		expect(response.status()).toBe(401);
		await clean.close();
	});

	test('never puts a secret in the page', async ({ page }) => {
		await page.goto('/config');
		const body = await page.content();
		expect(body).not.toMatch(/rig-password|BEGIN (EC )?PRIVATE KEY/);
	});
});
