import { OPERATOR_PAGES, expect, test } from './utils/rig';

/**
 * Every page renders, in a real engine, against the real API.
 *
 * The component project mounts one component at a time against happy-dom. It cannot see a page
 * whose data call failed, whose router never resolved, or whose markup mounted and then threw --
 * all of which present as a green unit suite and a blank screen.
 */
test.describe('every page', () => {
	for (const path of OPERATOR_PAGES) {
		test(`${path} renders its own content`, async ({ page }) => {
			await page.goto(path);
			await expect(page.locator('main')).toBeVisible();
			const text = await page.locator('main').innerText();
			expect(text.trim().length, `${path} rendered an empty main`).toBeGreaterThan(0);
		});

		test(`${path} announces itself with exactly one h1`, async ({ page }) => {
			await page.goto(path);
			await expect(page.locator('h1')).toHaveCount(1);
		});
	}
});

test.describe('the overview', () => {
	test('shows the capacity answer with its binding term and provenance', async ({ page }) => {
		await page.goto('/');
		const main = page.locator('main');
		await expect(main).toContainText('site storage on disk');
		await expect(main).toContainText('assumed');
	});

	test('renders the health tree down to a leaf finding', async ({ page }) => {
		await page.goto('/');
		await expect(page.locator('main')).toContainText('the last drill failed');
	});

	test('does not present a declared limit as an enforced one', async ({ page }) => {
		await page.goto('/');
		const row = page.locator('tr', { hasText: 'startup time' });
		await expect(row).toContainText('declared');
		await expect(row.locator('[data-state="enforced"]')).toHaveCount(0);
	});
});

test.describe('the data pages render what the API actually answered', () => {
	test('analytics shows a site row, not an empty table', async ({ page }) => {
		await page.goto('/analytics');
		await expect(page.locator('main')).toContainText('www.example.edu');
	});

	test('cluster names a node the control plane could not reach', async ({ page }) => {
		await page.goto('/cluster');
		await expect(page.locator('main')).toContainText('node-b');
		await expect(page.locator('main')).toContainText('unreachable');
	});

	test('tenants shows the quota, which is what makes delegation safe', async ({ page }) => {
		await page.goto('/tenants');
		await expect(page.locator('[data-test="quota"]')).toHaveText('40');
	});

	test('operations shows the audit chain and the backups', async ({ page }) => {
		await page.goto('/operations');
		await expect(page.locator('main')).toContainText('cert.issued');
		await expect(page.locator('main')).toContainText('www.example.edu');
	});

	test('logs render the lines the level asked for', async ({ page }) => {
		await page.goto('/logs');
		await expect(page.locator('main')).toContainText('served 200 for /node/1');
	});
});

test.describe('failure is shown rather than swallowed', () => {
	test('names the error when a call fails, instead of rendering an empty page', async ({
		page
	}) => {
		await page.route('**/api/capacity', (route) => route.fulfill({ status: 500, body: '{}' }));
		await page.goto('/');
		await expect(page.locator('main')).toContainText(/error|failed|could not/i);
	});
});
