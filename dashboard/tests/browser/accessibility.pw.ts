import type { Page } from '@playwright/test';
import { OPERATOR_PAGES, expect, openSections, test } from './utils/rig';

/**
 * WCAG 2.2 AA, where a browser can decide it.
 *
 * These are normative requirements with success-criterion ids, not preferences, and each one is a
 * thing only a real engine can answer: a computed focus style, a layout at 320 px, an accessible
 * name resolved through the accname algorithm. The component project cannot compute any of them.
 */

test.describe('structure (1.3.1, 2.4.1 -- Level A)', () => {
	for (const path of OPERATOR_PAGES) {
		test(`${path} has one main landmark and names every nav`, async ({ page }) => {
			await page.goto(path);
			await expect(page.locator('main')).toHaveCount(1);
			// more than one nav is fine; two unnamed ones are not, because a screen reader then
			// offers the user two landmarks called "navigation"
			const unnamed = await page.evaluate(
				() =>
					[...document.querySelectorAll('nav')].filter(
						(element) =>
							!element.getAttribute('aria-label') &&
							!element.getAttribute('aria-labelledby')
					).length
			);
			expect(unnamed, 'a nav landmark has no accessible name').toBe(0);
		});
	}

	/**
	 * Tabs into a mounted document.
	 *
	 * Two things have to be true first, and both were found by this lane rather than reasoned out:
	 * the shell must have mounted, because tab order before hydration is not the order under test,
	 * and the body must hold focus, because a touch device starts with focus nowhere and Tab from
	 * a body that never had it does not move sequential focus.
	 */
	const tabIntoDocument = async (page: Page): Promise<void> => {
		await page.locator('#main').waitFor({ state: 'attached' });
		await page.evaluate(() => {
			document.body.setAttribute('tabindex', '-1');
			document.body.focus();
		});
		await page.keyboard.press('Tab');
	};

	test('the first focusable element skips the navigation', async ({ page }) => {
		await page.goto('/');
		await tabIntoDocument(page);
		const skip = page.locator(':focus');
		await expect(skip).toHaveAttribute('href', '#main');
		await expect(skip).toBeVisible();
	});

	test('the skip link moves focus into the main region', async ({ page }) => {
		await page.goto('/');
		await tabIntoDocument(page);
		await page.keyboard.press('Enter');
		await expect(page.locator('main')).toBeFocused();
	});
});

test.describe('navigation (2.4.7, 1.4.1, 4.1.2)', () => {
	test('marks the current page with more than a colour', async ({ page }) => {
		await page.goto('/health');
		const nav = await openSections(page);
		const current = nav.locator('a[aria-current="page"]');
		await expect(current).toHaveCount(1);
		await expect(current).toHaveText('Health');
	});

	// tabbed rather than `.focus()`d: `:focus-visible` is what carries the ring, and a programmatic
	// focus does not reliably set it, so the old form asserted against a state no user reaches
	test('every keyboard-reachable control shows a focus indicator', async ({ page }) => {
		await page.goto('/');
		await page.locator('body').press('Tab');

		const unringed: string[] = [];
		for (let step = 0; step < 14; step++) {
			const described = await page.evaluate(() => {
				const element = document.activeElement as HTMLElement | null;
				if (element === null || element === document.body) return null;
				// the pseudo-elements count: a ring drawn on `::before` is the technique Nuxt UI
				// uses for its navigation links, and it is just as visible as an outline
				const rings = (target: HTMLElement, pseudo?: string): boolean => {
					const style = getComputedStyle(target, pseudo);
					return (
						(style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
						(style.boxShadow !== 'none' && style.boxShadow !== '')
					);
				};
				return {
					ringed:
						rings(element) || rings(element, '::before') || rings(element, '::after'),
					label: `${element.tagName}:${(element.textContent ?? '').trim().slice(0, 20)}`
				};
			});
			if (described === null) break;
			if (!described.ringed) unringed.push(described.label);
			await page.keyboard.press('Tab');
		}

		expect(unringed, 'these focused controls showed no indicator').toEqual([]);
	});

	test('navigating does not reload the document, which would drop the SPA', async ({ page }) => {
		await page.goto('/');
		await page.evaluate(() => {
			(window as unknown as { __kept: boolean }).__kept = true;
		});
		const nav = await openSections(page);
		await nav.getByRole('link', { name: 'Health' }).click();
		await expect(page).toHaveURL(/\/health$/);
		expect(
			await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept === true),
			'the page reloaded instead of routing'
		).toBe(true);
	});

	test('names every control the keyboard can reach', async ({ page }) => {
		await page.goto('/');
		const unnamed = await page.evaluate(() =>
			[...document.querySelectorAll<HTMLElement>('a[href], button')]
				.filter((element) => element.offsetParent !== null)
				.filter(
					(element) =>
						(element.textContent ?? '').trim() === '' &&
						!element.getAttribute('aria-label') &&
						!element.getAttribute('title')
				)
				.map((element) => element.outerHTML.slice(0, 80))
		);
		expect(unnamed, 'these controls have no accessible name').toEqual([]);
	});
});

test.describe('reflow (1.4.10 AA) and target size (2.5.8 AA)', () => {
	for (const path of OPERATOR_PAGES) {
		test(`${path} does not scroll sideways at 320 px`, async ({ page }) => {
			await page.setViewportSize({ width: 320, height: 720 });
			await page.goto(path);
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth
			);
			expect(
				overflow,
				`${path} overflows by ${overflow}px at 320 CSS px`
			).toBeLessThanOrEqual(0);
		});
	}

	test('every pointer target is at least 24 CSS px, or spaced to the exception', async ({
		page
	}) => {
		await page.goto('/');
		const small = await page.evaluate(() =>
			[...document.querySelectorAll<HTMLElement>('button, a[href], input, select')]
				.filter((element) => element.offsetParent !== null)
				// the inline exception: a target inside a sentence is bound by its line height
				.filter((element) => getComputedStyle(element).display !== 'inline')
				.map((element) => ({
					rect: element.getBoundingClientRect(),
					html: element.outerHTML.slice(0, 60)
				}))
				.filter(({ rect }) => rect.width < 24 || rect.height < 24)
				.map(
					({ html, rect }) =>
						`${html} is ${Math.round(rect.width)}x${Math.round(rect.height)}`
				)
		);
		expect(small, 'these targets are under the 24px AA floor').toEqual([]);
	});
});

test.describe('motion (2.3.3) and colour (1.4.1)', () => {
	test.use({ reducedMotion: 'reduce' });

	test('honours a reduced-motion preference', async ({ page }) => {
		await page.goto('/');
		const moving = await page.evaluate(() =>
			[...document.querySelectorAll<HTMLElement>('*')]
				.filter((element) => {
					const style = getComputedStyle(element);
					// the neutraliser leaves 0.01ms rather than 0, because a true zero cancels
					// transitionend and some libraries wait on it
					const moves = (value: string) =>
						value.split(',').some((part) => parseFloat(part) > 0.05);
					return (
						(moves(style.animationDuration) &&
							style.animationName !== 'none' &&
							style.animationIterationCount !== '1') ||
						moves(style.transitionDuration)
					);
				})
				.map((element) => element.tagName + '.' + element.className)
				.slice(0, 5)
		);
		expect(moving, 'these still animate under prefers-reduced-motion').toEqual([]);
	});
});

test.describe('text scaling (1.4.4 AA)', () => {
	test('stays readable and contained at 200% text size', async ({ page }) => {
		await page.goto('/');
		await page.addStyleTag({ content: 'html { font-size: 32px }' });
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow, 'doubling the text size forced a horizontal scroll').toBeLessThanOrEqual(
			0
		);
	});
});

test.describe('colour mode', () => {
	test('offers a three-way theme control with a spoken label', async ({ page }) => {
		await page.goto('/');
		await openSections(page);
		const toggle = page.locator('[data-test="theme"]:visible').first();
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute('aria-label', /Theme:/);
	});

	test('switches the document theme and remembers the choice', async ({ page }) => {
		await page.goto('/');
		await openSections(page);
		const toggle = page.locator('[data-test="theme"]:visible').first();
		await toggle.click();
		await expect(page.locator('html')).toHaveClass(/light/);
		await toggle.click();
		await expect(page.locator('html')).toHaveClass(/dark/);
		await page.reload();
		await expect(page.locator('html')).toHaveClass(/dark/);
	});

	test('reads legibly in both themes rather than only the one it was designed in', async ({
		page
	}) => {
		await page.goto('/');
		for (const theme of ['light', 'dark']) {
			await page.evaluate((mode) => {
				localStorage.setItem('bastion-color-mode', mode);
			}, theme);
			await page.reload();
			const ground = await page.evaluate(() => {
				const body = getComputedStyle(document.body).backgroundColor;
				const text = getComputedStyle(document.body).color;
				return { body, text };
			});
			expect(ground.body, `${theme} left the body transparent`).not.toBe('rgba(0, 0, 0, 0)');
			expect(ground.text).not.toBe(ground.body);
		}
	});
});
