import type { BastionConfig, LogLevel } from '../config/types';
import type { HealthLedger } from './ledger';
import { finding, type Finding } from './tripwires';

/**
 * Everything a probe may read, assembled once by whoever is doing the sweep.
 *
 * A snapshot of plain data rather than live handles, so every probe is a pure function of it and a
 * spec can put the box in any state without a kernel, a hypervisor or a clock. That is the whole
 * reason this shape exists: 33 tripwire codes shipped with nothing raising any of them, and a
 * condition nobody can simulate is a condition nobody writes a test for.
 *
 * **Absent means unmeasured, and an unmeasured input never produces a finding.** A probe that
 * cannot read what it needs returns null rather than guessing, so a host whose cgroup files are not
 * there reads as quiet rather than as healthy or as broken.
 */
export interface HealthInput {
	now: number;
	config: Pick<BastionConfig, 'mode' | 'runtime' | 'tenants'>;
	host?: HostSample;
	tenants?: TenantSample[];
	runtime?: RuntimeSample;
	front?: FrontSample;
	adapters?: AdapterSample[];
	cache?: CacheSample;
	certificates?: CertificateSample[];
	egress?: EgressSample;
	secrets?: SecretsSample;
	backups?: BackupSample[];
	audit?: { chainOk: boolean; brokenAt?: number };
	vms?: VmSample[];
	isolation?: { configured: string; available: string };
}

export interface HostSample {
	totalBytes?: number;
	freeBytes?: number;
	/** bytes per second the state directory is growing, signed; negative is shrinking */
	growthBytesPerSecond?: number;
	inodesTotal?: number;
	inodesFree?: number;
	/** the cgroup's own `memory.events`, never dmesg */
	memoryPressureEvents?: number;
	oomKills?: number;
	/** one-minute load average against the core count, so the ratio is what is compared */
	loadAverage?: number;
	cores?: number;
	clockOffsetMs?: number;
	clockSource?: string | null;
}

export interface TenantSample {
	name: string;
	sites: number;
	maxSites?: number;
	/** how many times the supervisor has restarted this tenant since it last ran clean */
	restarts?: number;
	quarantined?: boolean;
	/** microseconds this tenant's cgroup spent throttled, from `cpu.stat` */
	throttledUs?: number;
	/** microseconds it ran for, so the throttle is a proportion rather than a raw count */
	ranUs?: number;
}

export interface RuntimeSample {
	/** the pin the configuration names */
	pinned?: string;
	/** what is actually executing, read from the running process */
	running?: string;
	/** whether the pin change crosses a recorded on-disk storage format change */
	formatChanged?: boolean;
	/** bytes each resident site holds, which only binds under `pin` residency */
	residentSiteBytes?: number;
	residentSites?: number;
	hostRamBytes?: number;
}

export interface FrontSample {
	rateLimited?: number;
	slowloris?: number;
	/** the window those counts cover, so a spike is a rate rather than a total */
	windowMs?: number;
}

export interface AdapterSample {
	slot: string;
	reachable?: boolean;
	reason?: string | null;
	/** true where a capability probe could not run and fell back to conservative defaults */
	degraded?: boolean;
	partialReads?: number;
}

export interface CacheSample {
	hits?: number;
	misses?: number;
	evictions?: number;
}

export interface CertificateSample {
	host: string;
	expiresAt?: number;
	lastRenewalFailedAt?: number;
}

export interface EgressSample {
	denied?: number;
	windowMs?: number;
	/** the live nftables table differs from the policy bastion computed */
	drifted?: boolean;
}

export interface SecretsSample {
	sealed?: boolean;
	/** epoch millis a rotation was due; a past value is overdue */
	rotationDueAt?: number;
}

export interface BackupSample {
	site: string;
	newestAt?: number;
	verifyFailedAt?: number;
	drillFailedAt?: number;
	/** null where a drill has never run, which is a warning rather than silence */
	lastDrillAt?: number | null;
}

export interface VmSample {
	tenant: string;
	booted?: boolean;
	hypervisorReachable?: boolean;
}

/**
 * The numbers a probe compares against.
 *
 * Defaults an operator can reason about, not measurements: they are here as one named table so a
 * deployment can argue with a specific value rather than with a magic number buried in a branch.
 * The two that ARE derived from something sit with their source: the certificate ladder is the one
 * `expirySeverity` already applies, and the crash-loop rung is the supervisor's own breaker.
 */
export const THRESHOLDS = {
	/** free space below this fraction is low; at zero it is exhausted */
	diskLowFraction: 0.1,
	/** how far ahead the growth trend is projected when deciding `disk_low` */
	diskProjectionMs: 24 * 60 * 60 * 1000,
	inodeLowFraction: 0.1,
	/** load per core sustained above this is worth saying out loud */
	loadPerCore: 2,
	/** a clock this far out breaks ACME, certificate validity, TOTP and the audit chain */
	clockSkewMs: 5 * 60 * 1000,
	/** the proportion of its CPU time a tenant may spend throttled before it is runaway */
	throttledFraction: 0.25,
	/** resident bytes against host RAM, above which `pin` residency is over-committed */
	residencyFraction: 0.8,
	/** refusals per minute at the front door that read as a spike rather than noise */
	perMinuteSpike: 60,
	/** a cache serving fewer than this fraction of reads from itself is thrashing */
	cacheHitFloor: 0.5,
	/** a backup older than this is stale */
	backupStaleMs: 36 * 60 * 60 * 1000
} as const;

/** one tripwire's detector; null means the condition is not present or not measurable */
export interface Probe {
	code: string;
	detect(input: HealthInput): Finding | Finding[] | null;
}

const rate = (count: number | undefined, windowMs: number | undefined): number | null => {
	if (count === undefined || windowMs === undefined || windowMs <= 0) return null;
	return count / (windowMs / 60_000);
};

const at = (input: HealthInput): number => input.now;

function each<T>(list: T[] | undefined, made: (item: T) => Finding | null): Finding[] | null {
	if (list === undefined) return null;
	const found = list.map(made).filter((entry): entry is Finding => entry !== null);
	return found.length === 0 ? null : found;
}

/**
 * Every tripwire's condition, one entry per code.
 *
 * `check:reachability` walks this against `TRIPWIRES` in both directions, so a code with no probe
 * and a probe with no code are both build failures. That is the rule that would have caught 33
 * tripwires raised by nothing.
 */
export const PROBES: Probe[] = [
	{
		code: 'host.disk_low',
		detect: (input) => {
			const { totalBytes, freeBytes, growthBytesPerSecond } = input.host ?? {};
			if (totalBytes === undefined || freeBytes === undefined || totalBytes === 0)
				return null;
			if (freeBytes === 0) return null; // exhausted is its own code, and worse
			const fraction = freeBytes / totalBytes;
			// the projection is what makes this a trend rather than a threshold: a disk at 40% that
			// is filling fast is a problem tonight, and one at 5% that is flat is not news
			const projected =
				growthBytesPerSecond === undefined || growthBytesPerSecond <= 0
					? freeBytes
					: freeBytes - growthBytesPerSecond * (THRESHOLDS.diskProjectionMs / 1000);
			if (fraction >= THRESHOLDS.diskLowFraction && projected > 0) return null;
			return finding('host.disk_low', 'host', at(input), {
				freeBytes,
				totalBytes,
				projectedFreeBytes: Math.round(projected)
			});
		}
	},
	{
		code: 'host.disk_exhausted',
		detect: (input) => {
			const { freeBytes } = input.host ?? {};
			if (freeBytes === undefined || freeBytes > 0) return null;
			return finding('host.disk_exhausted', 'host', at(input), { freeBytes });
		}
	},
	{
		code: 'host.inode_low',
		detect: (input) => {
			const { inodesTotal, inodesFree } = input.host ?? {};
			if (inodesTotal === undefined || inodesFree === undefined || inodesTotal === 0) {
				return null;
			}
			if (inodesFree / inodesTotal >= THRESHOLDS.inodeLowFraction) return null;
			// inodes run out before bytes on a store of many small files, and a disk check alone
			// reports a healthy box that cannot create a file
			return finding('host.inode_low', 'host', at(input), { inodesFree, inodesTotal });
		}
	},
	{
		code: 'host.memory_pressure',
		detect: (input) => {
			const events = input.host?.memoryPressureEvents;
			if (events === undefined || events === 0) return null;
			return finding('host.memory_pressure', 'host', at(input), { events });
		}
	},
	{
		code: 'host.oom_kill',
		detect: (input) => {
			const kills = input.host?.oomKills;
			if (kills === undefined || kills === 0) return null;
			return finding('host.oom_kill', 'host', at(input), { kills });
		}
	},
	{
		code: 'host.load_sustained',
		detect: (input) => {
			const { loadAverage, cores } = input.host ?? {};
			if (loadAverage === undefined || cores === undefined || cores === 0) return null;
			const perCore = loadAverage / cores;
			if (perCore <= THRESHOLDS.loadPerCore) return null;
			return finding('host.load_sustained', 'host', at(input), {
				loadAverage,
				cores,
				perCore
			});
		}
	},
	{
		code: 'host.clock_skew',
		detect: (input) => {
			const offset = input.host?.clockOffsetMs;
			if (offset === undefined) return null;
			if (Math.abs(offset) <= THRESHOLDS.clockSkewMs) return null;
			// one finding covering four failures: ACME, certificate validity, TOTP and the audit
			// chain all read the clock, so a skewed one breaks them together
			return finding('host.clock_skew', 'host', at(input), {
				offsetMs: offset,
				source: input.host?.clockSource ?? null
			});
		}
	},
	{
		code: 'runtime.workerd_restart',
		detect: (input) =>
			each(input.tenants, (tenant) =>
				(tenant.restarts ?? 0) > 0 && tenant.quarantined !== true
					? finding('runtime.workerd_restart', tenant.name, at(input), {
							restarts: tenant.restarts
						})
					: null
			)
	},
	{
		code: 'runtime.crash_loop',
		detect: (input) =>
			each(input.tenants, (tenant) =>
				tenant.quarantined === true
					? finding('runtime.crash_loop', tenant.name, at(input), {
							restarts: tenant.restarts ?? 0
						})
					: null
			)
	},
	{
		code: 'runtime.pin_drift',
		detect: (input) => {
			const { pinned, running } = input.runtime ?? {};
			if (pinned === undefined || running === undefined || pinned === running) return null;
			return finding('runtime.pin_drift', 'runtime', at(input), { pinned, running });
		}
	},
	{
		code: 'runtime.storage_format_change',
		detect: (input) => {
			if (input.runtime?.formatChanged !== true) return null;
			// a rollback across a format change is not a rollback, so this is not a footnote
			return finding('runtime.storage_format_change', 'runtime', at(input), {
				pinned: input.runtime.pinned ?? null
			});
		}
	},
	{
		code: 'runtime.residency_pressure',
		detect: (input) => {
			if (input.config.runtime.residency !== 'pin') return null;
			const { residentSiteBytes, residentSites, hostRamBytes } = input.runtime ?? {};
			if (
				residentSiteBytes === undefined ||
				residentSites === undefined ||
				hostRamBytes === undefined ||
				hostRamBytes === 0
			) {
				return null;
			}
			const held = residentSiteBytes * residentSites;
			if (held / hostRamBytes <= THRESHOLDS.residencyFraction) return null;
			// `memory.grow` has no inverse: a pinned site holds its bytes until the process dies,
			// so this is the one that ends in an OOM kill taking every object with it
			return finding('runtime.residency_pressure', 'runtime', at(input), {
				heldBytes: held,
				hostRamBytes
			});
		}
	},
	{
		code: 'runtime.cpu_runaway',
		detect: (input) =>
			each(input.tenants, (tenant) => {
				const { throttledUs, ranUs } = tenant;
				if (throttledUs === undefined || ranUs === undefined || ranUs === 0) return null;
				if (throttledUs / ranUs <= THRESHOLDS.throttledFraction) return null;
				// workerd enforces no CPU limit at all, so a `while(true)` is bounded only by the
				// cgroup; sustained throttling is what that looks like from outside
				return finding('runtime.cpu_runaway', tenant.name, at(input), {
					throttledUs,
					ranUs
				});
			})
	},
	{
		code: 'tenant.quota_exceeded',
		detect: (input) =>
			each(input.tenants, (tenant) =>
				tenant.maxSites !== undefined && tenant.sites > tenant.maxSites
					? finding('tenant.quota_exceeded', tenant.name, at(input), {
							sites: tenant.sites,
							maxSites: tenant.maxSites
						})
					: null
			)
	},
	{
		code: 'front.rate_limited_spike',
		detect: (input) => {
			const perMinute = rate(input.front?.rateLimited, input.front?.windowMs);
			if (perMinute === null || perMinute <= THRESHOLDS.perMinuteSpike) return null;
			return finding('front.rate_limited_spike', 'front', at(input), { perMinute });
		}
	},
	{
		code: 'front.slowloris',
		detect: (input) => {
			const perMinute = rate(input.front?.slowloris, input.front?.windowMs);
			if (perMinute === null || perMinute <= THRESHOLDS.perMinuteSpike) return null;
			return finding('front.slowloris', 'front', at(input), { perMinute });
		}
	},
	{
		code: 'adapter.unreachable',
		detect: (input) =>
			each(input.adapters, (adapter) =>
				adapter.reachable === false
					? finding('adapter.unreachable', adapter.slot, at(input), {
							reason: adapter.reason ?? null
						})
					: null
			)
	},
	{
		code: 'adapter.capability_degraded',
		detect: (input) =>
			each(input.adapters, (adapter) =>
				adapter.degraded === true
					? finding('adapter.capability_degraded', adapter.slot, at(input), {})
					: null
			)
	},
	{
		code: 'adapter.partial_read',
		detect: (input) =>
			each(input.adapters, (adapter) =>
				(adapter.partialReads ?? 0) > 0
					? // a truncated value is indistinguishable from a real one, which is why the
						// store contract refuses rather than returning it and why this is critical
						finding('adapter.partial_read', adapter.slot, at(input), {
							reads: adapter.partialReads
						})
					: null
			)
	},
	{
		code: 'cache.thrashing',
		detect: (input) => {
			const { hits, misses } = input.cache ?? {};
			if (hits === undefined || misses === undefined) return null;
			const total = hits + misses;
			if (total === 0) return null;
			if (hits / total >= THRESHOLDS.cacheHitFloor) return null;
			// the edge tier absorbs 82% of anonymous traffic; with it missing, all of it reaches
			// the single-threaded object, which is roughly a fivefold throughput cut
			return finding('cache.thrashing', 'cache', at(input), { hits, misses });
		}
	},
	{
		code: 'cert.expiring',
		detect: (input) =>
			each(input.certificates, (certificate) => {
				if (certificate.expiresAt === undefined) return null;
				const left = certificate.expiresAt - input.now;
				if (left > 21 * 24 * 60 * 60 * 1000) return null;
				const severity: LogLevel =
					left <= 2 * 24 * 60 * 60 * 1000
						? 'critical'
						: left <= 7 * 24 * 60 * 60 * 1000
							? 'error'
							: 'warn';
				return {
					...finding('cert.expiring', certificate.host, at(input), {
						expiresAt: certificate.expiresAt
					}),
					severity
				};
			})
	},
	{
		code: 'cert.renewal_failed',
		detect: (input) =>
			each(input.certificates, (certificate) =>
				certificate.lastRenewalFailedAt === undefined
					? null
					: finding('cert.renewal_failed', certificate.host, at(input), {
							failedAt: certificate.lastRenewalFailedAt
						})
			)
	},
	{
		code: 'egress.denied_spike',
		detect: (input) => {
			const perMinute = rate(input.egress?.denied, input.egress?.windowMs);
			if (perMinute === null || perMinute <= THRESHOLDS.perMinuteSpike) return null;
			// misconfiguration or compromise, and the operator needs to know which; the context
			// carries the rate so the answer is in the finding rather than in a guess
			return finding('egress.denied_spike', 'egress', at(input), { perMinute });
		}
	},
	{
		code: 'egress.policy_drift',
		detect: (input) =>
			input.egress?.drifted === true
				? finding('egress.policy_drift', 'egress', at(input), {})
				: null
	},
	{
		code: 'secrets.sealed',
		detect: (input) =>
			input.secrets?.sealed === true
				? finding('secrets.sealed', 'secrets', at(input), {})
				: null
	},
	{
		code: 'secrets.rotation_overdue',
		detect: (input) => {
			const due = input.secrets?.rotationDueAt;
			if (due === undefined || due > input.now) return null;
			return finding('secrets.rotation_overdue', 'secrets', at(input), { dueAt: due });
		}
	},
	{
		code: 'backup.stale',
		detect: (input) =>
			each(input.backups, (backup) =>
				backup.newestAt === undefined ||
				input.now - backup.newestAt <= THRESHOLDS.backupStaleMs
					? null
					: finding('backup.stale', backup.site, at(input), { newestAt: backup.newestAt })
			)
	},
	{
		code: 'backup.verify_failed',
		detect: (input) =>
			each(input.backups, (backup) =>
				backup.verifyFailedAt === undefined
					? null
					: finding('backup.verify_failed', backup.site, at(input), {
							failedAt: backup.verifyFailedAt
						})
			)
	},
	{
		code: 'backup.drill_failed',
		detect: (input) =>
			each(input.backups, (backup) => {
				if (backup.drillFailedAt !== undefined) {
					return finding('backup.drill_failed', backup.site, at(input), {
						failedAt: backup.drillFailedAt
					});
				}
				// a drill that has never run is a warning rather than silence: a backup nobody has
				// restored is not a backup
				if (backup.lastDrillAt === null) {
					return {
						...finding('backup.drill_failed', backup.site, at(input), {
							neverRun: true
						}),
						severity: 'warn' as LogLevel
					};
				}
				return null;
			})
	},
	{
		code: 'audit.chain_broken',
		detect: (input) => {
			if (input.audit === undefined || input.audit.chainOk) return null;
			// the chain is what makes a deletion detectable, so a break is critical even though
			// nothing is down
			return finding('audit.chain_broken', 'audit', at(input), {
				brokenAt: input.audit.brokenAt ?? null
			});
		}
	},
	{
		code: 'vm.boot_failed',
		detect: (input) =>
			each(input.vms, (vm) =>
				vm.booted === false ? finding('vm.boot_failed', vm.tenant, at(input), {}) : null
			)
	},
	{
		code: 'vm.hypervisor_unreachable',
		detect: (input) =>
			each(input.vms, (vm) =>
				vm.hypervisorReachable === false
					? finding('vm.hypervisor_unreachable', vm.tenant, at(input), {})
					: null
			)
	},
	{
		code: 'isolation.mode_downgraded',
		detect: (input) => {
			const { configured, available } = input.isolation ?? {};
			if (configured === undefined || available === undefined || configured === available) {
				return null;
			}
			// bastion refuses rather than downgrading, so this records the mechanism that
			// disappeared: serving `hardened` where the operator configured `isolated` silently is
			// the exact failure the project exists to prevent
			return finding('isolation.mode_downgraded', 'isolation', at(input), {
				configured,
				available
			});
		}
	}
];

export const PROBE_BY_CODE: Record<string, Probe> = Object.fromEntries(
	PROBES.map((probe) => [probe.code, probe])
);

/** every finding the current snapshot produces, in table order */
export function detectAll(input: HealthInput): Finding[] {
	const found: Finding[] = [];
	for (const probe of PROBES) {
		const answer = probe.detect(input);
		if (answer === null) continue;
		if (Array.isArray(answer)) found.push(...answer);
		else found.push(answer);
	}
	return found;
}

/**
 * Detects, records what is new, and clears what has recovered.
 *
 * Recording only the transitions is what keeps the file bounded without a retention policy doing
 * all the work: a disk that stays low produces one finding, not one per sweep. A code that was open
 * and is now absent is cleared, which is what lets the ladder's strike count fall back.
 */
export function sweep(ledger: HealthLedger, input: HealthInput): Finding[] {
	const found = detectAll(input);
	const open = new Set(found.map((entry) => `${entry.scope}/${entry.code}`));
	const already = new Set(
		ledger.all
			.filter((entry) => ledger.state(entry.finding.scope, entry.finding.code).strikes > 0)
			.map((entry) => `${entry.finding.scope}/${entry.finding.code}`)
	);

	for (const entry of found) {
		if (already.has(`${entry.scope}/${entry.code}`)) continue;
		ledger.record(entry);
	}
	for (const key of already) {
		if (open.has(key)) continue;
		const [scope, code] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
		ledger.recovered(scope as string, code as string);
	}
	return found;
}
