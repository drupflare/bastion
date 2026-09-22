import { describe, expect, it } from 'vitest';
import {
	admitSite,
	capacity,
	defaultCostModel,
	readHost,
	refine,
	type HostReading
} from '../../../src/capacity/model';
import { RESIDENT_SITE_BYTES } from '../../../src/config/defaults';
import { defaultContext } from '../../../src/context';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';

const GiB = 1024 ** 3;

function host(over: Partial<HostReading> = {}): HostReading {
	return {
		cores: 8,
		memoryBytes: 16 * GiB,
		diskBytes: 500 * GiB,
		diskFreeBytes: 400 * GiB,
		terms: [
			{
				name: 'cores',
				value: 8,
				unit: 'cores',
				provenance: 'probed',
				source: '/proc/cpuinfo'
			},
			{
				name: 'memory',
				value: 16 * GiB,
				unit: 'bytes',
				provenance: 'probed',
				source: '/proc/meminfo'
			},
			{
				name: 'disk free',
				value: 400 * GiB,
				unit: 'bytes',
				provenance: 'probed',
				source: 'statfs'
			}
		],
		...over
	};
}

describe('readHost', () => {
	it('probes cores, memory and disk from this host', () => {
		const files = memoryFiles(
			{
				'/proc/cpuinfo': 'processor\t: 0\nprocessor\t: 1\n',
				'/proc/meminfo': 'MemTotal:       16384000 kB\n',
				'/var/lib/bastion': ''
			},
			{ totalBytes: 500 * GiB, freeBytes: 400 * GiB }
		);
		const ctx = { ...defaultContext(), files, io: memoryIo(), env: {} };
		const reading = readHost(ctx, '/var/lib/bastion');
		expect(reading.cores).toBe(2);
		expect(reading.memoryBytes).toBe(16384000 * 1024);
		expect(reading.diskFreeBytes).toBe(400 * GiB);
		expect(reading.terms.every((t) => t.provenance === 'probed')).toBe(true);
	});

	it('marks what it could not read as assumed rather than probed', () => {
		const ctx = { ...defaultContext(), files: memoryFiles(), io: memoryIo(), env: {} };
		const reading = readHost(ctx, '/var/lib/bastion');
		expect(reading.terms.find((t) => t.name === 'cores')?.provenance).toBe('assumed');
		expect(reading.terms.find((t) => t.name === 'disk free')?.provenance).toBe('assumed');
	});
});

describe('the cost model', () => {
	it('starts every term assumed, because none of them has been measured on this host yet', () => {
		const model = defaultCostModel('solo');
		expect(model.residentSiteBytes.provenance).toBe('assumed');
		expect(model.residentSiteBytes.value).toBe(RESIDENT_SITE_BYTES);
	});

	it('adds a microVM term only in isolated', () => {
		expect(defaultCostModel('solo').microVmBytes).toBe(null);
		expect(defaultCostModel('hardened').microVmBytes).toBe(null);
		expect(defaultCostModel('isolated').microVmBytes).not.toBe(null);
	});

	it('promotes a term to probed once this host has actually read it', () => {
		const refined = refine(defaultCostModel('solo'), { residentSiteBytes: 50 * 1024 * 1024 });
		expect(refined.residentSiteBytes.provenance).toBe('probed');
		expect(refined.residentSiteBytes.value).toBe(50 * 1024 * 1024);
	});

	it('leaves a term alone when there is no reading for it', () => {
		const refined = refine(defaultCostModel('solo'), {});
		expect(refined.siteStorageBytes.provenance).toBe('assumed');
	});
});

describe('capacity', () => {
	const model = defaultCostModel('solo');

	it('is bound by disk under evict, and reports the RAM ceiling separately', () => {
		const answer = capacity(host(), model, { residency: 'evict', tenants: 1 });
		expect(answer.bindingTerm).toBe('site storage on disk');
		expect(answer.concurrencyCeiling).toBeGreaterThan(0);
		expect(answer.maximum).toBeGreaterThan(answer.concurrencyCeiling as number);
	});

	it('is bound by RAM under pin, because every site is resident forever', () => {
		const answer = capacity(host(), model, { residency: 'pin', tenants: 1 });
		expect(answer.bindingTerm).toContain('pin');
		expect(answer.concurrencyCeiling).toBe(null);
	});

	it('recommends below the maximum rather than at it', () => {
		const answer = capacity(host(), model, { residency: 'evict', tenants: 1 });
		expect(answer.recommended).toBeLessThan(answer.maximum);
	});

	it('carries the WEAKEST provenance of its inputs, so an assumption cannot hide', () => {
		const answer = capacity(host(), model, { residency: 'evict', tenants: 1 });
		expect(answer.provenance).toBe('assumed');
	});

	it('reports probed only once every input has been read', () => {
		const measured = refine(model, {
			residentSiteBytes: 50 * 1024 * 1024,
			siteStorageBytes: 5 * 1024 * 1024,
			tenantBaselineBytes: 13 * 1024 * 1024
		});
		expect(capacity(host(), measured, { residency: 'evict', tenants: 1 }).provenance).toBe(
			'probed'
		);
	});

	it('charges the tenant baseline once per tenant rather than once per site', () => {
		const one = capacity(host(), model, { residency: 'pin', tenants: 1 });
		const many = capacity(host(), model, { residency: 'pin', tenants: 20 });
		expect(many.maximum).toBeLessThan(one.maximum);
	});

	it('charges a microVM per tenant in isolated', () => {
		const plain = capacity(host(), defaultCostModel('solo'), { residency: 'pin', tenants: 10 });
		const vms = capacity(host(), defaultCostModel('isolated'), {
			residency: 'pin',
			tenants: 10
		});
		expect(vms.maximum).toBeLessThan(plain.maximum);
	});

	it('says plainly that the figure is not a density', () => {
		const answer = capacity(host(), model, { residency: 'evict', tenants: 1 });
		expect(answer.notes.join(' ')).toContain('must not be quoted as one');
	});

	it('says what pin costs that evict does not', () => {
		const answer = capacity(host(), model, { residency: 'pin', tenants: 1 });
		expect(answer.notes.join(' ')).toContain('has no inverse');
	});

	it('answers zero rather than a negative when the host is already full', () => {
		const tiny = host({ memoryBytes: 1024, diskFreeBytes: 0 });
		const answer = capacity(tiny, model, { residency: 'evict', tenants: 100 });
		expect(answer.maximum).toBe(0);
		expect(answer.concurrencyCeiling).toBe(0);
	});
});

describe('admitSite', () => {
	const answer = capacity(host(), defaultCostModel('solo'), { residency: 'evict', tenants: 1 });

	it('refuses past a configured maximum, naming the count AND the binding term', () => {
		try {
			admitSite(40, answer, 40);
			expect.unreachable('should have refused');
		} catch (e) {
			expect((e as Error).message).toContain('40 sites');
			expect((e as Error).message).toContain('site storage on disk');
		}
	});

	it('admits below the configured maximum', () => {
		expect(admitSite(1, answer, 40)).toEqual({ ok: true, warning: null });
	});

	it('warns past the recommendation without a ceiling set, rather than refusing', () => {
		const result = admitSite(answer.recommended + 1, answer);
		expect(result.ok).toBe(true);
		expect(result.warning).toContain('the recommendation is');
	});
});

describe('an unmeasured host', () => {
	const model = defaultCostModel('solo');
	const unread: HostReading = {
		cores: 1,
		memoryBytes: 0,
		diskBytes: 0,
		diskFreeBytes: 0,
		terms: []
	};

	it('says it could not be measured rather than reporting a ceiling of zero', () => {
		const answer = capacity(unread, model, { residency: 'evict', tenants: 1 });
		expect(answer.known).toBe(false);
		expect(answer.notes.join(' ')).toContain('not a ceiling');
	});

	it('says the same under pin', () => {
		const answer = capacity(unread, model, { residency: 'pin', tenants: 1 });
		expect(answer.known).toBe(false);
		expect(answer.notes.join(' ')).toContain('not a ceiling');
	});

	it('reports a measured host as known', () => {
		expect(capacity(host(), model, { residency: 'evict', tenants: 1 }).known).toBe(true);
	});

	it('does not warn on `site add` when there is no measurement to warn against', () => {
		const answer = capacity(unread, model, { residency: 'evict', tenants: 1 });
		expect(admitSite(5, answer)).toEqual({ ok: true, warning: null });
	});

	it('still refuses past an explicit ceiling, which does not depend on a measurement', () => {
		const answer = capacity(unread, model, { residency: 'evict', tenants: 1 });
		expect(() => admitSite(40, answer, 40)).toThrow(/configured maximum/);
	});
});
