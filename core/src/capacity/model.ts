import { RESIDENT_SITE_BYTES } from '../config/defaults';
import type { BastionConfig, Residency } from '../config/types';
import type { Context } from '../context';
import { BastionError } from '../errors';

/** how a number was arrived at; `probed` beats `stated` beats `assumed`, and never silently */
export type Provenance = 'probed' | 'stated' | 'assumed';

export interface Term {
	name: string;
	value: number;
	unit: string;
	provenance: Provenance;
	source: string;
}

export interface HostReading {
	cores: number;
	memoryBytes: number;
	diskBytes: number;
	diskFreeBytes: number;
	terms: Term[];
}

/**
 * What this host is, read from this host.
 *
 * The roadmap already constrains this harder than it looks: it refuses a sites-per-server DENSITY
 * as a publishable figure, because that rests on a memory reading taken on a binary the project no
 * longer ships and assumes every tenant is simultaneously resident, which is the thing `thermal.ts`
 * exists to prevent. So bastion computes what THIS host can hold from THIS host's readings, and
 * never publishes a general density number. That is a different claim, and it is the one an
 * operator actually needs.
 */
export function readHost(ctx: Context, statePath: string): HostReading {
	const terms: Term[] = [];
	const meminfo = '/proc/meminfo';
	const cpuinfo = '/proc/cpuinfo';

	let cores = 1;
	if (ctx.files.exists(cpuinfo)) {
		cores = ctx.files
			.readText(cpuinfo)
			.split('\n')
			.filter((l) => l.startsWith('processor')).length;
		terms.push({
			name: 'cores',
			value: cores,
			unit: 'cores',
			provenance: 'probed',
			source: cpuinfo
		});
	} else {
		terms.push({
			name: 'cores',
			value: cores,
			unit: 'cores',
			provenance: 'assumed',
			source: 'no /proc/cpuinfo'
		});
	}

	let memoryBytes = 0;
	if (ctx.files.exists(meminfo)) {
		const line = ctx.files
			.readText(meminfo)
			.split('\n')
			.find((l) => l.startsWith('MemTotal:'));
		memoryBytes = Number(line?.split(/\s+/)[1] ?? 0) * 1024;
		terms.push({
			name: 'memory',
			value: memoryBytes,
			unit: 'bytes',
			provenance: 'probed',
			source: meminfo
		});
	} else {
		terms.push({
			name: 'memory',
			value: 0,
			unit: 'bytes',
			provenance: 'assumed',
			source: 'no /proc/meminfo'
		});
	}

	const space = ctx.files.space(statePath);
	terms.push({
		name: 'disk free',
		value: space?.freeBytes ?? 0,
		unit: 'bytes',
		provenance: space === null ? 'assumed' : 'probed',
		source: space === null ? `${statePath} could not be measured` : `statfs on ${statePath}`
	});

	return {
		cores,
		memoryBytes,
		diskBytes: space?.totalBytes ?? 0,
		diskFreeBytes: space?.freeBytes ?? 0,
		terms
	};
}

export interface CostModel {
	/** worst-case resident RAM for one site */
	residentSiteBytes: Term;
	/** the site database plus its WAL */
	siteStorageBytes: Term;
	/** one workerd process plus its interpreter, SHARED across that tenant's sites */
	tenantBaselineBytes: Term;
	/** `isolated` only */
	microVmBytes: Term | null;
}

export function defaultCostModel(mode: BastionConfig['mode']): CostModel {
	return {
		residentSiteBytes: {
			name: 'resident site RAM',
			value: RESIDENT_SITE_BYTES,
			unit: 'bytes',
			provenance: 'assumed',
			source: 'the re-derived growth ladder, worst case'
		},
		siteStorageBytes: {
			name: 'site storage',
			value: 5 * 1024 * 1024,
			unit: 'bytes',
			provenance: 'assumed',
			source: 'measured at provisioning; grows with content'
		},
		tenantBaselineBytes: {
			name: 'per-tenant baseline',
			value: 13.4 * 1024 * 1024,
			unit: 'bytes',
			provenance: 'assumed',
			source: 'one workerd process plus the interpreter'
		},
		microVmBytes:
			mode === 'isolated'
				? {
						name: 'per-tenant microVM',
						value: 128 * 1024 * 1024,
						unit: 'bytes',
						provenance: 'assumed',
						source: 'not yet measured; Phase 14 replaces this with a reading'
					}
				: null
	};
}

/** replaces an assumed term with a reading from this host, which is the whole point of probing */
export function refine(
	model: CostModel,
	readings: Partial<Record<keyof CostModel, number>>
): CostModel {
	const applied = { ...model };
	for (const [key, value] of Object.entries(readings)) {
		const term = applied[key as keyof CostModel];
		if (term === null || term === undefined || value === undefined) continue;
		applied[key as 'residentSiteBytes'] = {
			...term,
			value,
			provenance: 'probed',
			source: "this host's own reading"
		};
	}
	return applied;
}

export interface CapacityAnswer {
	/** false when a term could not be read at all, so 0 is not reported as a real ceiling */
	known: boolean;
	/** what bastion recommends this host holds */
	recommended: number;
	/** the most it could hold before the binding term runs out */
	maximum: number;
	/** which term binds, named rather than implied */
	bindingTerm: string;
	/** the weakest provenance of any input, so a figure with an assumption says so */
	provenance: Provenance;
	terms: Term[];
	/** with `evict`, RAM bounds CONCURRENCY rather than the site count */
	concurrencyCeiling: number | null;
	notes: string[];
}

const WEAKEST: Provenance[] = ['probed', 'stated', 'assumed'];

function weakest(terms: Term[]): Provenance {
	let out: Provenance = 'probed';
	for (const term of terms) {
		if (WEAKEST.indexOf(term.provenance) > WEAKEST.indexOf(out)) out = term.provenance;
	}
	return out;
}

/**
 * How many sites this host holds.
 *
 * Residency decides which term binds, and the two cases are not the same question. Under `evict`
 * a site is dropped after ten seconds idle, so RAM scales with the CONCURRENT WORKING SET and the
 * term that scales with the site count is disk; the answer reports a disk-bound maximum and a
 * RAM-bound concurrency ceiling separately. Under `pin` every site is resident forever, so RAM
 * scales with the count directly and that is what binds.
 *
 * Every output names the binding term and carries the weakest provenance of its inputs. A capacity
 * number presented as measured when an input was assumed is the exact failure the provenance
 * column exists to stop.
 */
export function capacity(
	host: HostReading,
	model: CostModel,
	options: { residency: Residency; tenants: number; reserveBytes?: number }
): CapacityAnswer {
	const reserve = options.reserveBytes ?? Math.min(host.memoryBytes * 0.2, 2 * 1024 ** 3);
	const baseline =
		options.tenants * (model.tenantBaselineBytes.value + (model.microVmBytes?.value ?? 0));
	const usableMemory = Math.max(0, host.memoryBytes - reserve - baseline);
	const usableDisk = Math.max(0, host.diskFreeBytes);

	const byMemory = Math.floor(usableMemory / model.residentSiteBytes.value);
	const byDisk =
		model.siteStorageBytes.value > 0
			? Math.floor(usableDisk / model.siteStorageBytes.value)
			: 0;

	const terms = [
		...host.terms,
		model.residentSiteBytes,
		model.siteStorageBytes,
		model.tenantBaselineBytes,
		...(model.microVmBytes === null ? [] : [model.microVmBytes])
	];

	// a host whose disk or memory could not be read answers `known: false` rather than 0. Zero is a
	// real number and would read as "this host holds nothing", which is a different claim from
	// "this host could not be measured"
	const known = host.memoryBytes > 0 && host.diskFreeBytes > 0;

	if (options.residency === 'pin') {
		const binding = byDisk > 0 && byDisk < byMemory ? 'disk' : 'memory';
		const maximum = binding === 'memory' ? byMemory : Math.min(byMemory, byDisk);
		return {
			known,
			recommended: Math.floor(maximum * 0.8),
			maximum,
			bindingTerm:
				binding === 'memory' ? 'resident site RAM under `pin`' : 'site storage on disk',
			provenance: weakest(terms),
			terms,
			concurrencyCeiling: null,
			notes: [
				...(known
					? []
					: [
							'this host could not be fully measured, so the counts above are not a ' +
								'ceiling. Run this on the host itself, on linux, for a real answer'
						]),
				'`pin` holds every site resident forever and nothing reclaims it: `memory.grow` has no ' +
					'inverse, so a site that was resident once costs its RAM until the process restarts'
			]
		};
	}

	return {
		known,
		recommended: Math.floor(byDisk * 0.8),
		maximum: byDisk,
		bindingTerm: 'site storage on disk',
		provenance: weakest(terms),
		terms,
		concurrencyCeiling: byMemory,
		notes: [
			...(known
				? []
				: [
						'this host could not be fully measured, so the counts below are not a ceiling. ' +
							'Run this on the host itself, on linux, for a real answer'
					]),
			`under \`evict\` RAM bounds how many sites may be resident AT ONCE (${byMemory}), not how ` +
				'many may exist',
			'this is what this host holds, from this host. It is not a sites-per-server density and ' +
				'must not be quoted as one'
		]
	};
}

/**
 * The gate `site add` runs.
 *
 * Refuses past a configured `maxSites`, naming the binding term AND the current count; a refusal
 * that only says "limit reached" makes an operator go looking for which limit. An unset ceiling is
 * no gate at all, and `capacity` still warns when the recommendation is exceeded, so a deliberately
 * low ceiling reads as a choice rather than a fault.
 */
export function admitSite(
	current: number,
	answer: CapacityAnswer,
	maxSites?: number
): { ok: boolean; warning: string | null } {
	if (!answer.known && maxSites === undefined) {
		// nothing was measured, so there is no recommendation to warn against
		return { ok: true, warning: null };
	}
	if (maxSites !== undefined && current >= maxSites) {
		throw new BastionError(
			'capacity-exceeded',
			`this node holds ${current} sites against its configured maximum of ${maxSites}. ` +
				`The binding term is ${answer.bindingTerm}, which allows ${answer.maximum}`,
			{ next: 'bastion capacity' }
		);
	}
	if (current >= answer.recommended) {
		return {
			ok: true,
			warning:
				`this node holds ${current} sites and the recommendation is ${answer.recommended}, ` +
				`bound by ${answer.bindingTerm}`
		};
	}
	return { ok: true, warning: null };
}
