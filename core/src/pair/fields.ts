import { createHash } from 'node:crypto';
import type { AuditLog } from '../audit/log';
import { capacity, defaultCostModel, readHost } from '../capacity/model';
import { DEFAULT_PAIRING } from '../config/defaults';
import type { BastionConfig } from '../config/types';
import type { Context } from '../context';
import { HealthLedger } from '../health/ledger';
import type { AnalyticsWindow } from '../observe/analytics';
import { VERSION } from '../version';
import {
	LEAVES_THE_BOX,
	NEVER_LEAVES_THE_BOX,
	nodeBodyOk,
	type CommandOutcome,
	type NodeMessageType
} from './wire';

/**
 * The only place a message body is built.
 *
 * Each function reads the box's own state and picks the fields the contract lists as leaving the
 * box, by name. Nothing is copied wholesale and then trimmed: a field that is not named here cannot
 * leave, whatever a config, a finding's context or a log line happens to hold. `allowed` then drops
 * any top-level key `LEAVES_THE_BOX` does not list for the type, and `checked` refuses a body the
 * contract would reject, so a builder that drifts fails here rather than at the control plane.
 */

export interface FieldInput {
	ctx: Context;
	config: BastionConfig;
	state: string;
	nodeId: string;
	/** `os.hostname()`; read by the caller so a spec can pass any value */
	hostname?: string;
	arch?: string;
}

const pairing = (config: BastionConfig) => config.pairing ?? DEFAULT_PAIRING;

/** names as typed, or a digest the control plane cannot reverse and no other box shares */
export function nameOf(name: string, nodeId: string, hashed: boolean): string {
	if (!hashed) return name.slice(0, 128);
	return `h:${createHash('sha256').update(`${nodeId}\n${name}`).digest('hex').slice(0, 24)}`;
}

/** the body with every top-level key the contract does not list for the type removed */
export function keepListed(
	type: NodeMessageType,
	body: Record<string, unknown>
): Record<string, unknown> {
	const fields = new Set(
		LEAVES_THE_BOX.filter((entry) => entry.type === type).map((e) => e.field)
	);
	return Object.fromEntries(Object.entries(body).filter(([key]) => fields.has(key)));
}

function checked<T extends Record<string, unknown>>(type: NodeMessageType, body: T): T {
	const kept = keepListed(type, body) as T;
	if (!nodeBodyOk(type, kept)) {
		throw new Error(`the ${type} body does not satisfy the fleet link contract`);
	}
	return kept;
}

// #region status

export function hostFacts(input: FieldInput): Record<string, string> {
	const { config } = input;
	return {
		...(pairing(config).sendHostname && input.hostname !== undefined && input.hostname !== ''
			? { hostname: input.hostname.slice(0, 253) }
			: {}),
		os: input.ctx.platform,
		arch: input.arch ?? process.arch,
		bastionVersion: VERSION,
		workerdVersion: config.runtime.workerd.version,
		mode: config.mode
	};
}

export function capacityNumbers(input: FieldInput): Record<string, number> {
	const { ctx, config, state } = input;
	const host = readHost(ctx, state);
	const answer = capacity(host, defaultCostModel(config.mode), {
		residency: config.runtime.residency,
		tenants: Math.max(1, config.tenants.length)
	});
	const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));
	return {
		tenantsUsed: config.tenants.length,
		sitesUsed: config.tenants.reduce((total, tenant) => total + tenant.sites.length, 0),
		cores: host.cores,
		memoryMbTotal: mb(host.memoryBytes),
		diskMbFree: mb(host.diskFreeBytes),
		...(answer.known ? { sitesRecommended: answer.recommended, sitesMax: answer.maximum } : {})
	};
}

export function statusBody(input: FieldInput) {
	const { config, nodeId } = input;
	const hashed = pairing(config).hashNames;
	return checked('status', {
		...hostFacts(input),
		nodeId,
		tenants: config.tenants.map((tenant) => nameOf(tenant.name, nodeId, hashed)),
		sites: config.tenants.flatMap((tenant) =>
			tenant.sites.map((site) => nameOf(site.host, nodeId, hashed))
		),
		namesHashed: hashed,
		capacity: capacityNumbers(input)
	});
}

// #endregion

// #region findings

const SCOPE_HOST = 'host';

export function findingsBody(input: FieldInput) {
	const { ctx, config, state, nodeId } = input;
	const hashed = pairing(config).hashNames;
	const ledger = new HealthLedger(ctx, state);
	const counts = new Map<string, { code: string; scope: string; count: number }>();
	for (const entry of ledger.all) {
		const { code, scope } = entry.finding;
		if (ledger.state(scope, code).strikes <= 0) continue;
		const key = `${scope}/${code}`;
		const held = counts.get(key) ?? { code, scope, count: 0 };
		held.count += 1;
		counts.set(key, held);
	}
	return checked('findings', {
		findings: [...counts.values()]
			.filter((entry) => /^[A-Za-z0-9._-]{1,64}$/.test(entry.code))
			.map((entry) => ({
				code: entry.code,
				site: entry.scope === SCOPE_HOST ? null : nameOf(entry.scope, nodeId, hashed),
				count: entry.count
			}))
	});
}

// #endregion

// #region metrics and usage

export function metricsBody(
	input: FieldInput,
	window: { from: number; to: number },
	analytics: AnalyticsWindow
) {
	const { config, nodeId } = input;
	const hashed = pairing(config).hashNames;
	const summary = analytics.summarise(window);
	const points = summary.flatMap((site) => {
		const label = nameOf(site.site, nodeId, hashed);
		return [
			{ name: 'requests', value: site.requests, site: label },
			{ name: 'requests.errors', value: site.errors, site: label },
			{ name: 'requests.refused', value: site.refusals, site: label },
			{ name: 'cache.fraction', value: round(site.cachedFraction), site: label },
			{ name: 'latency.p95.ms', value: site.p95Ms, site: label },
			{ name: 'response.bytes', value: site.bytes, site: label }
		];
	});
	return checked('metrics.batch', {
		windowStart: new Date(window.from).toISOString().replace(/\.\d{3}Z$/, 'Z'),
		windowEnd: new Date(window.to).toISOString().replace(/\.\d{3}Z$/, 'Z'),
		requests: summary.reduce((total, site) => total + site.requests, 0),
		points
	});
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

const HOUR_MS = 3_600_000;

/**
 * Completed hours of served requests per site, for the sites the control plane has named.
 *
 * Counts come from the in-memory request window, which is bounded and does not survive a restart,
 * so an hour the window may have dropped samples from is `estimated` with the count as its lower
 * bound, never `exact`. A site with no control plane id is left out: a host name is not an id the
 * contract accepts, and inventing one would bill someone else's number.
 */
export function usageBody(
	input: { nodeId: string; now: number; siteIds: Record<string, string> },
	analytics: AnalyticsWindow,
	since: number
) {
	const end = Math.floor(input.now / HOUR_MS) * HOUR_MS;
	const first = Math.max(Math.floor(since / HOUR_MS) * HOUR_MS, end - 24 * HOUR_MS);
	const retained = analytics.within({ from: 0, to: input.now });
	const oldest = retained.reduce((least, sample) => Math.min(least, sample.at), Infinity);
	const full = analytics.size >= analytics.limit;
	const intervals: Record<string, unknown>[] = [];
	for (let start = first; start < end; start += HOUR_MS) {
		const bySite = new Map<string, number>();
		for (const sample of analytics.within({ from: start, to: start + HOUR_MS - 1 })) {
			bySite.set(sample.site, (bySite.get(sample.site) ?? 0) + 1);
		}
		for (const [host, views] of bySite) {
			const siteId = input.siteIds[host];
			if (siteId === undefined) continue;
			intervals.push({
				siteId,
				start: iso(start),
				end: iso(start + HOUR_MS),
				accuracy: full && oldest > start ? 'estimated' : 'exact',
				views,
				lowerBound: views,
				observedViews: views,
				settlement: 'open'
			});
		}
	}
	if (intervals.length === 0) return null;
	return checked('usage.report', {
		reportId: `usage_${input.nodeId.slice(4)}_${end}`.slice(0, 64),
		source: 'node',
		sentAt: iso(input.now),
		intervals
	});
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// #endregion

// #region audit and results

export function auditHeadBody(log: Pick<AuditLog, 'length' | 'chainHead'>) {
	return checked('audit.head', { seq: log.length, hash: `sha256:${log.chainHead}` });
}

export function commandResultBody(
	command: { opId: string; stepId: string; idempotencyKey: string },
	result: {
		outcome: CommandOutcome;
		code: string | null;
		deploy: { version: string; deployedAt: string } | null;
	}
) {
	return checked('command.result', {
		opId: command.opId,
		stepId: command.stepId,
		idempotencyKey: command.idempotencyKey,
		outcome: result.outcome,
		code: result.code,
		deploy: result.deploy
	});
}

// #endregion

export interface FieldGroup {
	type: string;
	fields: { field: string; description: string }[];
}

/** what `bastion pair --show-fields` and the console print, read from the contract's own list */
export function fieldGroups(): { leaves: FieldGroup[]; never: readonly string[] } {
	const leaves: FieldGroup[] = [];
	for (const entry of LEAVES_THE_BOX) {
		let group = leaves.find((candidate) => candidate.type === entry.type);
		if (group === undefined) {
			group = { type: entry.type, fields: [] };
			leaves.push(group);
		}
		group.fields.push({ field: entry.field, description: entry.description });
	}
	return { leaves, never: NEVER_LEAVES_THE_BOX };
}
