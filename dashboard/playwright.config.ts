import { defineConfig, devices, type ReporterDescription } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * The browser lane.
 *
 * The component project runs against happy-dom and cannot see a page that mounts with a widget
 * that threw, a focus ring that was styled away, or a table that scrolls the body sideways at
 * phone width. This one runs the built SPA in a real engine against the real management API, and
 * fails on a console error.
 *
 * Specs are named `*.pw.ts` so the dashboard's vitest project, which globs `tests/**\/*.spec.ts`,
 * does not try to run them.
 */
const isCI = !!process.env.CI;
const PORT = Number(process.env.BASTION_BROWSER_PORT ?? 8788);
const BASE_URL = process.env.BASTION_BROWSER_URL ?? `https://127.0.0.1:${PORT}`;

const reporters: ReporterDescription[] = [
	['list'],
	['html', { open: 'never', outputFolder: 'playwright-report' }]
];

if (isCI) {
	reporters.push(['github']);
	reporters.push(['junit', { outputFile: 'playwright-report/junit.xml' }]);
}

export default defineConfig({
	testDir: './tests/browser',
	testMatch: '**/*.pw.ts',
	testIgnore: ['**/utils/**'],
	fullyParallel: true,
	workers: isCI ? 2 : undefined,
	forbidOnly: isCI,
	retries: isCI ? 1 : 0,
	timeout: 60_000,
	expect: { timeout: 10_000 },
	reporter: reporters,
	outputDir: 'playwright-results',
	webServer: {
		// built rather than `nuxi dev`: the lane asserts what ships, and the dev server injects a
		// client that the production CSP would refuse
		command: 'bunx nuxi generate && bun tests/browser/utils/server.ts',
		url: `${BASE_URL}/rig/session`,
		ignoreHTTPSErrors: true,
		reuseExistingServer: !isCI,
		timeout: 180_000,
		stdout: 'pipe',
		stderr: 'pipe'
	},
	use: {
		baseURL: BASE_URL,
		// the rig terminates TLS with a certificate bastion signed for itself, because the session
		// cookie carries `__Host-` and will not be set over plain HTTP
		ignoreHTTPSErrors: true,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
		actionTimeout: 10_000,
		navigationTimeout: 30_000
	},
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'mobile', use: { ...devices['Pixel 7'] } }
	],
	globalSetup: fileURLToPath(new URL('./tests/browser/utils/global-setup.ts', import.meta.url))
});
