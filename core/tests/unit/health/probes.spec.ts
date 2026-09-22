import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../../src/config/defaults';
import { defaultContext } from '../../../src/context';
import { HealthLedger } from '../../../src/health/ledger';
import {
	PROBES,
	PROBE_BY_CODE,
	THRESHOLDS,
	detectAll,
	sweep,
	type HealthInput
} from '../../../src/health/probes';
import { BY_CODE, TRIPWIRES } from '../../../src/health/tripwires';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';

/**
 * Every tripwire's condition, simulated.
 *
 * bastion shipped 33 tripwire codes, a health ledger, a circuit breaker and a repair ladder with
 * nothing anywhere raising a single one of them. The probe table made each condition a pure
 * function of a snapshot, which is what makes this file possible: no kernel, no hypervisor, no
 * clock, just the state a box would be in.
 *
 * Two assertions per code, and they are different questions. Quiet: the condition absent produces
 * nothing, so a healthy box stays silent. Tripped: the condition present produces the finding with
 * the severity and repair the table declares.
 */
const NOW = Date.UTC(2026, 8, 22, 12);
const DAY = 24 * 60 * 60 * 1000;

function input(over: Partial<HealthInput> = {}): HealthInput {
	const config = defaultConfig();
	return {
		now: NOW,
		config: { mode: config.mode, runtime: config.runtime, tenants: [] },
		...over
	};
}

const codesFrom = (found: { code: string }[]): string[] => found.map((entry) => entry.code);

/** what one probe answers on its own, so a fixture for one code cannot satisfy another */
function only(code: string, over: Partial<HealthInput>): ReturnType<typeof detectAll> {
	const probe = PROBE_BY_CODE[code];
	if (probe === undefined) throw new Error(`no probe for ${code}`);
	const answer = probe.detect(input(over));
	if (answer === null) return [];
	return Array.isArray(answer) ? answer : [answer];
}

describe('the probe table', () => {
	it('has one probe per tripwire and no orphans, which the reachability check also enforces', () => {
		expect(PROBES.map((probe) => probe.code).sort()).toEqual(
			TRIPWIRES.map((tripwire) => tripwire.code).sort()
		);
	});

	it('finds nothing at all on a box with nothing measured', () => {
		expect(detectAll(input())).toEqual([]);
	});

	/**
	 * An unmeasured input is not a healthy one.
	 *
	 * Every sample is optional, and a probe whose inputs are absent returns null rather than
	 * treating zero as the reading. A host whose cgroup files are not there has to read as quiet,
	 * because the alternative is a box reporting `oomKills: 0` it never looked for.
	 */
	it('stays quiet for every probe when its inputs are absent', () => {
		for (const probe of PROBES) {
			expect(probe.detect(input()), probe.code).toBeNull();
		}
	});

	/**
	 * A finding carries the severity its tripwire declares, unless the probe grades it.
	 *
	 * `finding()` reads the table, so the two agree by construction everywhere except the two codes
	 * that climb with the condition: a certificate three weeks out and one two days out are not the
	 * same call, and a drill that has never run is a warning where one that failed is an error.
	 */
	it('takes its severity from the table, so the two cannot disagree', () => {
		const found = only('host.oom_kill', { host: { oomKills: 1 } });
		expect(found[0]?.severity).toBe(BY_CODE['host.oom_kill']?.severity);
	});

	/**
	 * Two codes climb with the condition rather than carrying one severity.
	 *
	 * A certificate three weeks out and one two days out are not the same call, and a drill that
	 * has never run is a warning where one that failed is an error. Everything else reads the
	 * table, which is why those two are named here rather than left to be noticed.
	 */
	it('grades the two codes whose severity depends on how bad it is', () => {
		const soon = only('cert.expiring', {
			certificates: [{ host: 'a', expiresAt: NOW + DAY }]
		});
		expect(soon[0]?.severity).toBe('critical');
		expect(soon[0]?.severity).not.toBe(BY_CODE['cert.expiring']?.severity);

		const never = only('backup.drill_failed', { backups: [{ site: 'a', lastDrillAt: null }] });
		expect(never[0]?.severity).toBe('warn');
		expect(never[0]?.severity).not.toBe(BY_CODE['backup.drill_failed']?.severity);
	});
});

describe('host', () => {
	it('is quiet on a disk with room', () => {
		expect(only('host.disk_low', { host: { totalBytes: 1000, freeBytes: 900 } })).toEqual([]);
	});

	it('finds disk_low below the fraction', () => {
		const found = only('host.disk_low', { host: { totalBytes: 1000, freeBytes: 50 } });
		expect(codesFrom(found)).toEqual(['host.disk_low']);
		expect(found[0]?.severity).toBe('warn');
	});

	/** a trend rather than a threshold: 40% free and filling fast is tonight's outage */
	it('finds disk_low from the projection alone, with room left today', () => {
		const found = only('host.disk_low', {
			host: { totalBytes: 1000, freeBytes: 400, growthBytesPerSecond: 1 }
		});
		expect(codesFrom(found)).toEqual(['host.disk_low']);
		expect(found[0]?.context.projectedFreeBytes).toBeLessThan(0);
	});

	it('does not project a shrinking disk into trouble', () => {
		expect(
			only('host.disk_low', {
				host: { totalBytes: 1000, freeBytes: 400, growthBytesPerSecond: -1 }
			})
		).toEqual([]);
	});

	it('leaves an exhausted disk to its own code rather than reporting both', () => {
		expect(only('host.disk_low', { host: { totalBytes: 1000, freeBytes: 0 } })).toEqual([]);
		const found = only('host.disk_exhausted', { host: { totalBytes: 1000, freeBytes: 0 } });
		expect(found[0]?.severity).toBe('critical');
	});

	it('is quiet on inodes with room and finds inode_low without bytes running out', () => {
		expect(only('host.inode_low', { host: { inodesTotal: 1000, inodesFree: 900 } })).toEqual(
			[]
		);
		const found = only('host.inode_low', {
			host: { totalBytes: 1000, freeBytes: 900, inodesTotal: 1000, inodesFree: 10 }
		});
		expect(codesFrom(found)).toEqual(['host.inode_low']);
	});

	it('reads memory pressure from the cgroup events, and stays quiet at zero', () => {
		expect(only('host.memory_pressure', { host: { memoryPressureEvents: 0 } })).toEqual([]);
		expect(
			codesFrom(only('host.memory_pressure', { host: { memoryPressureEvents: 3 } }))
		).toEqual(['host.memory_pressure']);
	});

	it('finds an oom kill, at the severity the table declares', () => {
		expect(only('host.oom_kill', { host: { oomKills: 0 } })).toEqual([]);
		const found = only('host.oom_kill', { host: { oomKills: 1 } });
		expect(found[0]?.severity).toBe(BY_CODE['host.oom_kill']?.severity);
	});

	it('compares load per core rather than raw load', () => {
		expect(only('host.load_sustained', { host: { loadAverage: 8, cores: 8 } })).toEqual([]);
		const found = only('host.load_sustained', { host: { loadAverage: 24, cores: 8 } });
		expect(found[0]?.context.perCore).toBe(3);
	});

	/** ACME, certificate validity, TOTP and the audit chain all read the clock */
	it('finds clock skew in either direction and carries the sync source', () => {
		expect(only('host.clock_skew', { host: { clockOffsetMs: 1000 } })).toEqual([]);
		for (const offset of [THRESHOLDS.clockSkewMs + 1, -(THRESHOLDS.clockSkewMs + 1)]) {
			const found = only('host.clock_skew', {
				host: { clockOffsetMs: offset, clockSource: 'chrony' }
			});
			expect(codesFrom(found), String(offset)).toEqual(['host.clock_skew']);
			expect(found[0]?.context.source).toBe('chrony');
		}
	});
});

describe('runtime', () => {
	const tenant = (over: Record<string, unknown> = {}) => ({
		tenants: [{ name: 'acme', sites: 1, ...over }]
	});

	it('reports a restart against the tenant it happened to', () => {
		expect(only('runtime.workerd_restart', tenant({ restarts: 0 }))).toEqual([]);
		const found = only('runtime.workerd_restart', tenant({ restarts: 2 }));
		expect(found[0]?.scope).toBe('acme');
		expect(found[0]?.severity).toBe('info');
	});

	/** once the breaker is open it is a crash loop, not a restart; reporting both is noise */
	it('reports a quarantined tenant as a crash loop rather than a restart', () => {
		const held = tenant({ restarts: 5, quarantined: true });
		expect(only('runtime.workerd_restart', held)).toEqual([]);
		const found = only('runtime.crash_loop', held);
		expect(found[0]?.severity).toBe('critical');
	});

	it('finds pin drift only when the running binary differs from the pin', () => {
		expect(
			only('runtime.pin_drift', { runtime: { pinned: '1.2.3', running: '1.2.3' } })
		).toEqual([]);
		const found = only('runtime.pin_drift', {
			runtime: { pinned: '1.2.3', running: '1.2.2' }
		});
		expect(found[0]?.context).toMatchObject({ pinned: '1.2.3', running: '1.2.2' });
	});

	it('finds a storage format change, which a rollback cannot cross', () => {
		expect(
			only('runtime.storage_format_change', { runtime: { formatChanged: false } })
		).toEqual([]);
		expect(
			codesFrom(only('runtime.storage_format_change', { runtime: { formatChanged: true } }))
		).toEqual(['runtime.storage_format_change']);
	});

	/**
	 * Residency pressure only binds under `pin`.
	 *
	 * Under `evict` a site is dropped after ten seconds idle, so RAM scales with the working set
	 * and holding more sites than fit is not a fault. Under `pin` nothing reclaims and
	 * `memory.grow` has no inverse.
	 */
	it('ignores residency pressure under evict and finds it under pin', () => {
		const held = {
			runtime: { residentSiteBytes: 100, residentSites: 10, hostRamBytes: 1000 }
		};
		expect(only('runtime.residency_pressure', held)).toEqual([]);

		const pinned = defaultConfig();
		pinned.runtime.residency = 'pin';
		const probe = PROBE_BY_CODE['runtime.residency_pressure'];
		const answer = probe?.detect({
			...input(held),
			config: { mode: pinned.mode, runtime: pinned.runtime, tenants: [] }
		});
		expect(answer).not.toBeNull();
	});

	/** workerd enforces no CPU limit at all, so the cgroup throttle is the only signal */
	it('finds cpu runaway from sustained throttling, as a proportion', () => {
		expect(only('runtime.cpu_runaway', tenant({ throttledUs: 1, ranUs: 100 }))).toEqual([]);
		const found = only('runtime.cpu_runaway', tenant({ throttledUs: 80, ranUs: 100 }));
		expect(found[0]?.scope).toBe('acme');
	});
});

describe('tenant and front door', () => {
	it('finds a tenant over its site quota, and not one at it', () => {
		expect(
			only('tenant.quota_exceeded', { tenants: [{ name: 'a', sites: 40, maxSites: 40 }] })
		).toEqual([]);
		const found = only('tenant.quota_exceeded', {
			tenants: [{ name: 'a', sites: 41, maxSites: 40 }]
		});
		expect(found[0]?.context).toMatchObject({ sites: 41, maxSites: 40 });
	});

	it('leaves a tenant with no ceiling alone', () => {
		expect(only('tenant.quota_exceeded', { tenants: [{ name: 'a', sites: 900 }] })).toEqual([]);
	});

	/** a rate rather than a total, so a long-running box does not trip on its own history */
	it('measures front-door refusals per minute', () => {
		expect(
			only('front.rate_limited_spike', { front: { rateLimited: 10_000, windowMs: 0 } })
		).toEqual([]);
		expect(
			only('front.rate_limited_spike', { front: { rateLimited: 10, windowMs: 60_000 } })
		).toEqual([]);
		const found = only('front.rate_limited_spike', {
			front: { rateLimited: 600, windowMs: 60_000 }
		});
		expect(found[0]?.context.perMinute).toBe(600);
	});

	it('measures slowloris the same way', () => {
		expect(only('front.slowloris', { front: { slowloris: 1, windowMs: 60_000 } })).toEqual([]);
		expect(
			codesFrom(only('front.slowloris', { front: { slowloris: 600, windowMs: 60_000 } }))
		).toEqual(['front.slowloris']);
	});
});

describe('adapters and cache', () => {
	it('reports an unreachable adapter against its slot, with the reason', () => {
		expect(
			only('adapter.unreachable', { adapters: [{ slot: 'kv', reachable: true }] })
		).toEqual([]);
		const found = only('adapter.unreachable', {
			adapters: [{ slot: 'kv', reachable: false, reason: 'connection refused' }]
		});
		expect(found[0]?.scope).toBe('kv');
		expect(found[0]?.context.reason).toBe('connection refused');
	});

	it('reports every unreachable adapter rather than only the first', () => {
		const found = only('adapter.unreachable', {
			adapters: [
				{ slot: 'kv', reachable: false },
				{ slot: 'r2', reachable: false }
			]
		});
		expect(found.map((entry) => entry.scope)).toEqual(['kv', 'r2']);
	});

	it('reports a capability probe that fell back to conservative defaults', () => {
		expect(
			only('adapter.capability_degraded', { adapters: [{ slot: 'r2', degraded: false }] })
		).toEqual([]);
		expect(
			codesFrom(
				only('adapter.capability_degraded', { adapters: [{ slot: 'r2', degraded: true }] })
			)
		).toEqual(['adapter.capability_degraded']);
	});

	/** a truncated value cannot be told from a real one, which is why this is critical */
	it('reports a partial read as critical', () => {
		expect(
			only('adapter.partial_read', { adapters: [{ slot: 'r2', partialReads: 0 }] })
		).toEqual([]);
		const found = only('adapter.partial_read', {
			adapters: [{ slot: 'r2', partialReads: 1 }]
		});
		expect(found[0]?.severity).toBe('critical');
	});

	it('finds a thrashing cache, and stays quiet on one that has served nothing', () => {
		expect(only('cache.thrashing', { cache: { hits: 0, misses: 0 } })).toEqual([]);
		expect(only('cache.thrashing', { cache: { hits: 90, misses: 10 } })).toEqual([]);
		const found = only('cache.thrashing', { cache: { hits: 10, misses: 90 } });
		expect(found[0]?.context).toMatchObject({ hits: 10, misses: 90 });
	});
});

describe('certificates', () => {
	const cert = (days: number) => ({
		certificates: [{ host: 'www.example.edu', expiresAt: NOW + days * DAY }]
	});

	it('is quiet outside the ladder', () => {
		expect(only('cert.expiring', cert(60))).toEqual([]);
	});

	/** the ladder the certificate store already applies: warn 21, error 7, critical 2 */
	it('climbs warn, error and critical as the expiry approaches', () => {
		expect(only('cert.expiring', cert(20))[0]?.severity).toBe('warn');
		expect(only('cert.expiring', cert(5))[0]?.severity).toBe('error');
		expect(only('cert.expiring', cert(1))[0]?.severity).toBe('critical');
	});

	it('reports an expired certificate as critical rather than forgetting it', () => {
		expect(only('cert.expiring', cert(-1))[0]?.severity).toBe('critical');
	});

	it('names the host it belongs to', () => {
		expect(only('cert.expiring', cert(1))[0]?.scope).toBe('www.example.edu');
	});

	it('reports a failed renewal separately from an expiry', () => {
		expect(
			only('cert.renewal_failed', {
				certificates: [{ host: 'a.example.edu', expiresAt: NOW + 60 * DAY }]
			})
		).toEqual([]);
		const found = only('cert.renewal_failed', {
			certificates: [{ host: 'a.example.edu', lastRenewalFailedAt: NOW - 1000 }]
		});
		expect(found[0]?.scope).toBe('a.example.edu');
	});
});

describe('egress, secrets, backups and the audit chain', () => {
	it('finds an egress denial spike, which is misconfiguration or compromise', () => {
		expect(only('egress.denied_spike', { egress: { denied: 5, windowMs: 60_000 } })).toEqual(
			[]
		);
		const found = only('egress.denied_spike', { egress: { denied: 900, windowMs: 60_000 } });
		expect(found[0]?.context.perMinute).toBe(900);
	});

	it('finds live nftables rules that no longer match the computed policy', () => {
		expect(only('egress.policy_drift', { egress: { drifted: false } })).toEqual([]);
		expect(codesFrom(only('egress.policy_drift', { egress: { drifted: true } }))).toEqual([
			'egress.policy_drift'
		]);
	});

	it('finds a sealed secret store', () => {
		expect(only('secrets.sealed', { secrets: { sealed: false } })).toEqual([]);
		expect(codesFrom(only('secrets.sealed', { secrets: { sealed: true } }))).toEqual([
			'secrets.sealed'
		]);
	});

	it('finds a rotation that is due, and not one still ahead', () => {
		expect(only('secrets.rotation_overdue', { secrets: { rotationDueAt: NOW + DAY } })).toEqual(
			[]
		);
		expect(
			codesFrom(only('secrets.rotation_overdue', { secrets: { rotationDueAt: NOW - DAY } }))
		).toEqual(['secrets.rotation_overdue']);
	});

	it('finds a stale backup per site', () => {
		expect(
			only('backup.stale', { backups: [{ site: 'a.edu', newestAt: NOW - 1000 }] })
		).toEqual([]);
		const found = only('backup.stale', {
			backups: [
				{ site: 'a.edu', newestAt: NOW - 1000 },
				{ site: 'b.edu', newestAt: NOW - 7 * DAY }
			]
		});
		expect(found.map((entry) => entry.scope)).toEqual(['b.edu']);
	});

	it('finds a verify that failed', () => {
		expect(only('backup.verify_failed', { backups: [{ site: 'a.edu' }] })).toEqual([]);
		expect(
			codesFrom(
				only('backup.verify_failed', {
					backups: [{ site: 'a.edu', verifyFailedAt: NOW - 1000 }]
				})
			)
		).toEqual(['backup.verify_failed']);
	});

	/** a backup nobody has restored is not a backup, so never having drilled is itself a finding */
	it('finds a failed drill, and a drill that has never run', () => {
		expect(
			only('backup.drill_failed', { backups: [{ site: 'a.edu', lastDrillAt: NOW }] })
		).toEqual([]);
		expect(
			only('backup.drill_failed', { backups: [{ site: 'a.edu', drillFailedAt: NOW }] })[0]
				?.severity
		).toBe('error');
		const never = only('backup.drill_failed', {
			backups: [{ site: 'a.edu', lastDrillAt: null }]
		});
		expect(never[0]?.severity).toBe('warn');
		expect(never[0]?.context.neverRun).toBe(true);
	});

	/** a deletion is only detectable because the chain is, so a break is critical */
	it('finds a broken audit chain as critical', () => {
		expect(only('audit.chain_broken', { audit: { chainOk: true } })).toEqual([]);
		const found = only('audit.chain_broken', { audit: { chainOk: false, brokenAt: 41 } });
		expect(found[0]?.severity).toBe('critical');
		expect(found[0]?.context.brokenAt).toBe(41);
	});
});

describe('microVMs and the isolation mode', () => {
	it('finds a guest that did not boot, per tenant', () => {
		expect(only('vm.boot_failed', { vms: [{ tenant: 'acme', booted: true }] })).toEqual([]);
		expect(only('vm.boot_failed', { vms: [{ tenant: 'acme', booted: false }] })[0]?.scope).toBe(
			'acme'
		);
	});

	it('finds an unreachable hypervisor', () => {
		expect(
			only('vm.hypervisor_unreachable', { vms: [{ tenant: 'a', hypervisorReachable: true }] })
		).toEqual([]);
		expect(
			codesFrom(
				only('vm.hypervisor_unreachable', {
					vms: [{ tenant: 'a', hypervisorReachable: false }]
				})
			)
		).toEqual(['vm.hypervisor_unreachable']);
	});

	/**
	 * bastion refuses rather than downgrading, so this records the mechanism that disappeared.
	 *
	 * Serving `hardened` where the operator configured `isolated` without saying so is the exact
	 * failure the project exists to prevent.
	 */
	it('finds a mode that no longer matches what the host can run', () => {
		expect(
			only('isolation.mode_downgraded', {
				isolation: { configured: 'isolated', available: 'isolated' }
			})
		).toEqual([]);
		const found = only('isolation.mode_downgraded', {
			isolation: { configured: 'isolated', available: 'hardened' }
		});
		expect(found[0]?.context).toMatchObject({ configured: 'isolated', available: 'hardened' });
	});
});

describe('a sweep against the ledger', () => {
	function ledger() {
		const ctx = {
			...defaultContext(),
			files: memoryFiles(),
			io: memoryIo(),
			now: () => NOW
		};
		return { ctx, ledger: new HealthLedger(ctx, '/srv/state') };
	}

	it('records what it finds', () => {
		const held = ledger();
		sweep(held.ledger, input({ host: { oomKills: 1 } }));
		expect(held.ledger.all.map((entry) => entry.finding.code)).toEqual(['host.oom_kill']);
	});

	/** a disk that stays low is one finding, not one per sweep; the file has to stay bounded */
	it('records a standing condition once rather than on every sweep', () => {
		const held = ledger();
		const state = input({ host: { totalBytes: 1000, freeBytes: 10 } });
		sweep(held.ledger, state);
		sweep(held.ledger, state);
		sweep(held.ledger, state);
		expect(held.ledger.all).toHaveLength(1);
	});

	it('clears a finding once the condition is gone, so the strike count can fall back', () => {
		const held = ledger();
		sweep(held.ledger, input({ host: { oomKills: 1 } }));
		expect(held.ledger.state('host', 'host.oom_kill').strikes).toBeGreaterThan(0);
		sweep(held.ledger, input({ host: { oomKills: 0 } }));
		expect(held.ledger.state('host', 'host.oom_kill').strikes).toBe(0);
	});

	it('records it again after it recovered and came back', () => {
		const held = ledger();
		sweep(held.ledger, input({ host: { oomKills: 1 } }));
		sweep(held.ledger, input({ host: { oomKills: 0 } }));
		sweep(held.ledger, input({ host: { oomKills: 2 } }));
		expect(held.ledger.all).toHaveLength(2);
	});
});
