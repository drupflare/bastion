import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	ACKNOWLEDGE_FLAG,
	assertModeSafe,
	MODE_TABLE,
	multiTenantWarning
} from '../../../src/isolation/modes';

describe('the mode table', () => {
	it('marks only isolated as multi-tenant safe', () => {
		expect(MODE_TABLE.solo.multiTenantSafe).toBe(false);
		expect(MODE_TABLE.hardened.multiTenantSafe).toBe(false);
		expect(MODE_TABLE.isolated.multiTenantSafe).toBe(true);
	});

	it('runs one process per tenant in every mode, so all three need cgroups', () => {
		for (const description of Object.values(MODE_TABLE)) {
			expect(description.requires).toContain('cgroups-v2');
		}
	});

	it('only isolated requires kvm', () => {
		expect(MODE_TABLE.isolated.requires).toContain('kvm');
		expect(MODE_TABLE.solo.requires).not.toContain('kvm');
		expect(MODE_TABLE.hardened.requires).not.toContain('kvm');
	});
});

describe('the refusal', () => {
	it('allows one tenant in an unsafe mode; there is nobody to isolate it from', () => {
		expect(assertModeSafe('solo', 1).warned).toBe(false);
		expect(assertModeSafe('hardened', 0).warned).toBe(false);
	});

	it('refuses two tenants in solo', () => {
		expect(() => assertModeSafe('solo', 2)).toThrow(/not multi-tenant safe/);
	});

	it('refuses two tenants in hardened', () => {
		expect(() => assertModeSafe('hardened', 2)).toThrow(/not multi-tenant safe/);
	});

	it('never refuses isolated, whatever the count', () => {
		expect(assertModeSafe('isolated', 500).warned).toBe(false);
	});

	it('carries the code and a next command', () => {
		try {
			assertModeSafe('solo', 2);
			expect.unreachable('should have refused');
		} catch (e) {
			expect((e as { code: string }).code).toBe('multi-tenant-unsafe');
			expect((e as { next: string }).next).toContain('isolated');
		}
	});

	it('accepts with the acknowledgement flag, and still reports that it warned', () => {
		const result = assertModeSafe('solo', 2, true);
		expect(result.warned).toBe(true);
		expect(result.warning).toContain(ACKNOWLEDGE_FLAG);
	});

	it('names the tenant count and the boundary in the warning', () => {
		const warning = multiTenantWarning('solo', 7);
		expect(warning).toContain('7 tenants');
		expect(warning).toContain('cgroups');
		expect(warning).toContain('isolated');
	});
});

describe('nothing describes an unsafe mode as safe', () => {
	// a second spec, because the documentation claim is the product claim here
	const sources = [
		'src/isolation/modes.ts',
		'src/config/types.ts',
		'../warden/README.md',
		'../PROGRESS.md'
	];

	for (const relative of sources) {
		it(`${relative} does not call solo or hardened multi-tenant safe`, () => {
			const text = readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8');
			// the claim would look like "solo ... multi-tenant safe" on one line
			for (const line of text.split('\n')) {
				const lower = line.toLowerCase();
				if (!/multi-tenant[ -]safe/.test(lower)) continue;
				if (!/\bsolo\b|\bhardened\b/.test(lower)) continue;
				expect(
					/\bnot\b|\bunsafe\b|false|never|refus/.test(lower),
					`claims safety on: ${line.trim()}`
				).toBe(true);
			}
		});
	}
});
