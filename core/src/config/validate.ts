import { DEFAULT_CAPABILITIES, LIMIT_FLOORS, RESIDENT_SITE_BYTES } from './defaults';
import { LOG_LEVELS, MODES, RESIDENCIES } from './types';

/** one rejection, carrying the path that produced it so a message is actionable */
export interface Problem {
	/** dotted path into the document, e.g. `tenants[0].sites[1].host` */
	path: string;
	message: string;
}

export interface ValidationResult {
	ok: boolean;
	problems: Problem[];
}

/** sizes may be written `128Mi`, `4Gi`, `900000` or `32M` */
export function parseSize(value: unknown, path: string, problems: Problem[]): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
	if (typeof value !== 'string') {
		problems.push({ path, message: 'must be a byte count or a size such as 128Mi' });
		return null;
	}
	const match = /^(\d+(?:\.\d+)?)\s*([KMGT]i?)?B?$/.exec(value.trim());
	if (match === null) {
		problems.push({ path, message: `\`${value}\` is not a size such as 128Mi or 4Gi` });
		return null;
	}
	const scale: Record<string, number> = {
		'': 1,
		K: 1000,
		M: 1000 ** 2,
		G: 1000 ** 3,
		T: 1000 ** 4,
		Ki: 1024,
		Mi: 1024 ** 2,
		Gi: 1024 ** 3,
		Ti: 1024 ** 4
	};
	return Math.floor(Number(match[1]) * (scale[match[2] ?? ''] ?? 1));
}

function requireOneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
	path: string,
	problems: Problem[]
): T | null {
	if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
		return value as T;
	problems.push({ path, message: `must be one of ${allowed.join(', ')}` });
	return null;
}

const HOSTNAME = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** the cache driver that answers every read as a miss; a 5x throughput cut wearing a config key */
const TEST_ONLY_CACHE_DRIVERS = new Set(['null']);

/**
 * Validates a parsed document and reports the PATH of every rejection.
 *
 * Hand-written rather than schema-driven so there is no runtime schema dependency;
 * `tests/unit/config/schema-parity.spec.ts` runs this and `config/schema.json` over one corpus
 * with ajv in the test lane only, so the two cannot drift.
 */
export function validate(raw: unknown, options: { testLane?: boolean } = {}): ValidationResult {
	const problems: Problem[] = [];
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, problems: [{ path: '', message: 'must be a mapping' }] };
	}
	const doc = raw as Record<string, unknown>;

	if (doc.version !== undefined && doc.version !== 1) {
		problems.push({ path: 'version', message: 'only version 1 is understood' });
	}
	if (doc.mode !== undefined) requireOneOf(doc.mode, MODES, 'mode', problems);
	if (doc.state !== undefined && typeof doc.state !== 'string') {
		problems.push({ path: 'state', message: 'must be a path' });
	}

	validateRuntime(doc.runtime, problems);
	validateDrivers(doc.drivers, problems, options.testLane === true);
	validateLogging(doc.audit, 'audit', problems);
	validateLogging(doc.logs, 'logs', problems);
	const tenants = validateTenants(doc.tenants, problems);
	validateCluster(doc.cluster, problems);

	// residency: pin is refused HERE rather than detected at runtime, because the alternative is an
	// OOM kill that takes every in-memory Durable Object in the tenant with it
	const runtime = doc.runtime as Record<string, unknown> | undefined;
	if (runtime?.residency === 'pin') {
		for (const [index, tenant] of tenants.entries()) {
			const limits = tenant.limits as Record<string, unknown> | undefined;
			if (limits?.memory === undefined) continue;
			const budget = parseSize(limits.memory, `tenants[${index}].limits.memory`, problems);
			if (budget === null) continue;
			const sites = Array.isArray(tenant.sites) ? tenant.sites.length : 0;
			const worst = Math.ceil(sites * RESIDENT_SITE_BYTES);
			if (worst > budget) {
				problems.push({
					path: `tenants[${index}].limits.memory`,
					message:
						`residency \`pin\` holds every site resident: ${sites} sites need ` +
						`${worst} bytes worst case against a ${budget} byte limit`
				});
			}
		}
	}

	return { ok: problems.length === 0, problems };
}

function validateRuntime(value: unknown, problems: Problem[]): void {
	if (value === undefined) return;
	if (value === null || typeof value !== 'object') {
		problems.push({ path: 'runtime', message: 'must be a mapping' });
		return;
	}
	const runtime = value as Record<string, unknown>;
	if (runtime.residency !== undefined) {
		requireOneOf(runtime.residency, RESIDENCIES, 'runtime.residency', problems);
	}
	if (runtime.unsafeEval !== undefined && typeof runtime.unsafeEval !== 'boolean') {
		problems.push({ path: 'runtime.unsafeEval', message: 'must be true or false' });
	}
	const limits = runtime.limits as Record<string, unknown> | undefined;
	if (limits === undefined) return;
	for (const [key, floor] of Object.entries(LIMIT_FLOORS)) {
		const given = limits[key];
		if (given === undefined) continue;
		const path = `runtime.limits.${key}`;
		const parsed = key === 'isolateMemory' ? parseSize(given, path, problems) : Number(given);
		if (parsed === null || !Number.isFinite(parsed)) {
			if (key !== 'isolateMemory') problems.push({ path, message: 'must be a number' });
			continue;
		}
		if (parsed < floor) {
			problems.push({
				path,
				message:
					`${parsed} is below the floor of ${floor}. Cloudflare's value is a FLOOR here ` +
					'because `worker` is optimised around it; raise it or leave it unset'
			});
		}
	}
}

function validateDrivers(value: unknown, problems: Problem[], testLane: boolean): void {
	if (value === undefined) return;
	if (value === null || typeof value !== 'object') {
		problems.push({ path: 'drivers', message: 'must be a mapping' });
		return;
	}
	for (const [slot, raw] of Object.entries(value as Record<string, unknown>)) {
		const path = `drivers.${slot}`;
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
			problems.push({ path, message: 'must be a mapping with a `driver` key' });
			continue;
		}
		const driver = (raw as Record<string, unknown>).driver;
		if (typeof driver !== 'string' || driver === '') {
			problems.push({ path: `${path}.driver`, message: 'must name a driver' });
			continue;
		}
		if (slot === 'cache' && TEST_ONLY_CACHE_DRIVERS.has(driver) && !testLane) {
			problems.push({
				path: `${path}.driver`,
				message:
					'`null` answers every read as a miss, so 100% of requests reach the Durable ' +
					'Object against 18% with a working cache. It is test-only'
			});
		}
	}
}

function validateLogging(value: unknown, path: string, problems: Problem[]): void {
	if (value === undefined) return;
	if (value === null || typeof value !== 'object') {
		problems.push({ path, message: 'must be a mapping' });
		return;
	}
	const level = (value as Record<string, unknown>).level;
	if (level !== undefined) requireOneOf(level, LOG_LEVELS, `${path}.level`, problems);
}

function validateCluster(value: unknown, problems: Problem[]): void {
	if (value === undefined) return;
	if (value === null || typeof value !== 'object') {
		problems.push({ path: 'cluster', message: 'must be a mapping' });
		return;
	}
	const cluster = value as Record<string, unknown>;
	const role = requireOneOf(
		cluster.role,
		['control', 'child'] as const,
		'cluster.role',
		problems
	);
	const node = cluster.node as Record<string, unknown> | undefined;
	if (node === undefined || typeof node.id !== 'string' || !NAME.test(node.id)) {
		problems.push({ path: 'cluster.node.id', message: 'must be a short lowercase node id' });
	}
	if (role === 'child') {
		const control = cluster.control as Record<string, unknown> | undefined;
		if (control === undefined || typeof control.address !== 'string') {
			problems.push({
				path: 'cluster.control.address',
				message: 'a child dials out, so it needs the control node address'
			});
		}
	}
}

function validateTenants(value: unknown, problems: Problem[]): Record<string, unknown>[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		problems.push({ path: 'tenants', message: 'must be a list' });
		return [];
	}
	const seenHosts = new Map<string, string>();
	const seenNames = new Set<string>();
	const tenants: Record<string, unknown>[] = [];

	for (const [index, raw] of value.entries()) {
		const path = `tenants[${index}]`;
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
			problems.push({ path, message: 'must be a mapping' });
			continue;
		}
		const tenant = raw as Record<string, unknown>;
		tenants.push(tenant);

		if (typeof tenant.name !== 'string' || !NAME.test(tenant.name)) {
			problems.push({ path: `${path}.name`, message: 'must be a short lowercase name' });
		} else if (seenNames.has(tenant.name)) {
			problems.push({ path: `${path}.name`, message: `duplicate tenant \`${tenant.name}\`` });
		} else {
			seenNames.add(tenant.name);
		}

		validateCapabilities(tenant.capabilities, `${path}.capabilities`, problems);

		if (!Array.isArray(tenant.sites)) {
			problems.push({ path: `${path}.sites`, message: 'must be a list' });
			continue;
		}
		const maxSites = (tenant.limits as Record<string, unknown> | undefined)?.maxSites;
		if (typeof maxSites === 'number' && tenant.sites.length > maxSites) {
			problems.push({
				path: `${path}.sites`,
				message: `${tenant.sites.length} sites against a maxSites of ${maxSites}`
			});
		}
		for (const [siteIndex, rawSite] of tenant.sites.entries()) {
			const sitePath = `${path}.sites[${siteIndex}]`;
			if (rawSite === null || typeof rawSite !== 'object') {
				problems.push({ path: sitePath, message: 'must be a mapping' });
				continue;
			}
			const site = rawSite as Record<string, unknown>;
			if (typeof site.host !== 'string' || !HOSTNAME.test(site.host)) {
				problems.push({ path: `${sitePath}.host`, message: 'must be a hostname' });
			} else {
				// a hostname IS site identity here, so two sites claiming one host is ambiguous
				// routing rather than a duplicate label. Compared case-insensitively because the
				// router keys on a lowercased host: two entries differing only in case collapsed
				// to one route, last write won, and it could happen ACROSS tenants
				const key = site.host.toLowerCase().replace(/\.$/, '');
				const owner = seenHosts.get(key);
				if (owner !== undefined) {
					problems.push({
						path: `${sitePath}.host`,
						message: `\`${site.host}\` is already served by ${owner}`
					});
				} else {
					seenHosts.set(key, path);
				}
				for (const rawAlias of Array.isArray(site.aliases) ? site.aliases : []) {
					if (typeof rawAlias !== 'string' || !HOSTNAME.test(rawAlias)) {
						problems.push({
							path: `${sitePath}.aliases`,
							message: 'must be hostnames'
						});
						continue;
					}
					const aliasKey = rawAlias.toLowerCase().replace(/\.$/, '');
					const aliasOwner = seenHosts.get(aliasKey);
					if (aliasOwner !== undefined) {
						problems.push({
							path: `${sitePath}.aliases`,
							message: `\`${rawAlias}\` is already served by ${aliasOwner}`
						});
					} else {
						seenHosts.set(aliasKey, path);
					}
				}
				if (typeof site.canonical === 'string') {
					const names = [site.host, ...(Array.isArray(site.aliases) ? site.aliases : [])]
						.filter((name): name is string => typeof name === 'string')
						.map((name) => name.toLowerCase());
					if (!names.includes(site.canonical.toLowerCase())) {
						problems.push({
							path: `${sitePath}.canonical`,
							message: `must be the host or one of its aliases; every request would redirect to a name this site does not serve`
						});
					}
				}
			}
			if (typeof site.bundle !== 'string' || site.bundle === '') {
				problems.push({ path: `${sitePath}.bundle`, message: 'must name a bundle' });
			}
			if (site.probe !== undefined && typeof site.probe !== 'string') {
				problems.push({ path: `${sitePath}.probe`, message: 'must name a probe profile' });
			}
		}
	}
	return tenants;
}

function validateCapabilities(value: unknown, path: string, problems: Problem[]): void {
	if (value === undefined) return;
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		problems.push({ path, message: 'must be a mapping' });
		return;
	}
	for (const [key, given] of Object.entries(value as Record<string, unknown>)) {
		if (!(key in DEFAULT_CAPABILITIES)) {
			problems.push({ path: `${path}.${key}`, message: 'is not a capability' });
			continue;
		}
		if (key === 'extensions') {
			if (!Array.isArray(given)) {
				problems.push({ path: `${path}.extensions`, message: 'must be a list of names' });
			}
			continue;
		}
		if (typeof given !== 'boolean') {
			problems.push({ path: `${path}.${key}`, message: 'must be true or false' });
		}
	}
}
