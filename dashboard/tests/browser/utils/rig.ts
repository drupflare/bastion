import { test as base, expect, type Locator, type Page } from '@playwright/test';

/** the pages an operator sees, which is also the nav's own list */
export const OPERATOR_PAGES = [
	'/',
	'/tenants',
	'/health',
	'/analytics',
	'/cluster',
	'/config',
	'/logs',
	'/manual',
	'/operations'
] as const;

/**
 * A signed-in page whose console is part of the assertion.
 *
 * A page that answers 200 with a widget that threw is the failure this lane exists to catch, and
 * it is invisible to a test that only looks at markup. Errors are collected rather than thrown at
 * once so a spec reports its own failure first and the console noise second.
 */
export const test = base.extend<{ page: Page; consoleErrors: string[] }>({
	consoleErrors: async ({ page }, use) => {
		const errors: string[] = [];
		page.on('console', (message) => {
			if (message.type() === 'error') errors.push(message.text());
		});
		page.on('pageerror', (error) => errors.push(error.message));
		await use(errors);
		expect(errors, 'the page logged errors').toEqual([]);
	},

	page: async ({ page, baseURL }, use) => {
		// mint the session before the SPA loads, so the first API call it makes is authenticated
		const response = await page.request.get(`${baseURL}/rig/session?role=operator`);
		expect(response.ok(), 'the rig minted a session').toBe(true);
		await use(page);
	}
});

export { expect };

/**
 * Brings the sidebar into view, whatever width the test is running at.
 *
 * Below `lg` the sidebar is a slideover behind a toggle, so a spec that reaches straight for a nav
 * link passes on desktop and times out on a phone. Opening it first is what a person does, and it
 * keeps one spec honest at both widths instead of forking into two.
 */
export function sections(page: Page): Locator {
	// two carry this name below `lg`: the hidden desktop sidebar and the slideover it opens into
	return page.locator('nav[aria-label="Sections"]:visible');
}

export async function openSections(page: Page): Promise<Locator> {
	// waited for rather than counted: before hydration there is no nav at ANY width, and a bare
	// count then sends the desktop case looking for a toggle that only exists on a phone
	try {
		await sections(page).first().waitFor({ state: 'visible', timeout: 3000 });
	} catch {
		await page
			.getByRole('button', { name: /sidebar|menu/i })
			.first()
			.click();
	}
	const nav = sections(page).first();
	await expect(nav).toBeVisible();
	return nav;
}
