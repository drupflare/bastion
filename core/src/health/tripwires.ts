import type { LogLevel } from '../config/types';
import type { Rung } from './ladder';

export interface Tripwire {
	code: string;
	severity: LogLevel;
	/** what it means, in the words `bastion diagnose` prints */
	means: string;
	/** the rung an automatic pass would take; null where only an operator acts */
	repair: Rung | null;
	/** the command an operator runs; every tripwire has one, which is what makes it reachable */
	button: string;
}

/**
 * Every tripwire, with its severity, its repair and its button.
 *
 * One table so `check:reachability` can walk it: a tripwire with no repair mapping and no button is
 * a build failure. `defects-only-a-deploy-found.md` opens with eleven tripwires, a health ledger, a
 * circuit breaker and a quarantine decision that shipped green and were wired to nothing, because
 * `repair_state` was read by the alarm and written by no one. That is what this table prevents.
 */
export const TRIPWIRES: Tripwire[] = [
	{
		code: 'host.disk_low',
		severity: 'warn',
		means: 'the projected disk trend crosses full',
		repair: 'observe',
		button: 'bastion health'
	},
	{
		code: 'host.disk_exhausted',
		severity: 'critical',
		means: 'the state disk is full',
		repair: 'reconfigure',
		button: 'bastion repair host.disk_exhausted'
	},
	{
		code: 'host.inode_low',
		severity: 'warn',
		means: 'inodes are running out before bytes are',
		repair: 'observe',
		button: 'bastion health'
	},
	{
		code: 'host.memory_pressure',
		severity: 'warn',
		means: 'a cgroup is reclaiming under its high mark',
		repair: 'observe',
		button: 'bastion health --tree'
	},
	{
		code: 'host.oom_kill',
		severity: 'error',
		means: 'the kernel killed a tenant',
		repair: 'reset',
		button: 'bastion repair host.oom_kill'
	},
	{
		code: 'host.load_sustained',
		severity: 'warn',
		means: 'load average has stayed above the core count',
		repair: 'observe',
		button: 'bastion health'
	},
	{
		code: 'host.clock_skew',
		severity: 'error',
		means: 'the clock is far enough out to break ACME, cert validity, TOTP and the audit chain',
		repair: 'observe',
		button: 'bastion doctor'
	},
	{
		code: 'runtime.workerd_restart',
		severity: 'info',
		means: 'a tenant process restarted',
		repair: 'observe',
		button: 'bastion status'
	},
	{
		code: 'runtime.crash_loop',
		severity: 'critical',
		means: 'a tenant is failing faster than the breaker window',
		repair: 'quarantine',
		button: 'bastion quarantine list'
	},
	{
		code: 'runtime.pin_drift',
		severity: 'error',
		means: 'the running binary is not the pinned one',
		repair: 'reset',
		button: 'bastion update apply'
	},
	{
		code: 'runtime.storage_format_change',
		severity: 'critical',
		means: 'a pin change crosses an on-disk layout change',
		repair: null,
		button: 'bastion backup verify'
	},
	{
		code: 'runtime.residency_pressure',
		severity: 'error',
		means: 'pinned sites would exceed the tenant memory limit',
		repair: 'reconfigure',
		button: 'bastion repair runtime.residency_pressure'
	},
	{
		code: 'runtime.cpu_runaway',
		severity: 'error',
		means: 'a tenant is pegged at its quota, which workerd cannot stop by itself',
		repair: 'reset',
		button: 'bastion repair runtime.cpu_runaway'
	},
	{
		code: 'tenant.quota_exceeded',
		severity: 'warn',
		means: 'a tenant is past a configured limit',
		repair: 'observe',
		button: 'bastion tenant limits'
	},
	{
		code: 'front.rate_limited_spike',
		severity: 'warn',
		means: 'the front door is refusing an unusual share of requests',
		repair: 'observe',
		button: 'bastion logs --since 10m'
	},
	{
		code: 'front.slowloris',
		severity: 'error',
		means: 'connections are open and sending almost nothing',
		repair: 'reset',
		button: 'bastion repair front.slowloris'
	},
	{
		code: 'adapter.unreachable',
		severity: 'error',
		means: 'a driver endpoint is not answering',
		repair: 'reset',
		button: 'bastion repair adapter.unreachable'
	},
	{
		code: 'adapter.capability_degraded',
		severity: 'warn',
		means: 'a probe fell back to conservative defaults',
		repair: 'observe',
		button: 'bastion doctor'
	},
	{
		code: 'adapter.partial_read',
		severity: 'critical',
		means: 'a driver returned fewer bytes than it declared',
		repair: null,
		button: 'bastion diagnose --code adapter.partial_read'
	},
	{
		code: 'cache.thrashing',
		severity: 'warn',
		means: 'the cache is evicting faster than it is serving',
		repair: 'reconfigure',
		button: 'bastion repair cache.thrashing'
	},
	{
		code: 'cert.expiring',
		severity: 'warn',
		means: 'a certificate is inside the expiry ladder',
		repair: 'reset',
		button: 'bastion cert renew'
	},
	{
		code: 'cert.renewal_failed',
		severity: 'error',
		means: 'a renewal attempt did not produce a certificate',
		repair: 'reset',
		button: 'bastion cert renew'
	},
	{
		code: 'egress.denied_spike',
		severity: 'error',
		means: 'a tenant is being denied egress unusually often, which is a misconfiguration or a compromise',
		repair: 'observe',
		button: 'bastion egress show'
	},
	{
		code: 'egress.policy_drift',
		severity: 'error',
		means: 'the live nftables table differs from the computed policy',
		repair: 'reconstruct',
		button: 'bastion repair egress.policy_drift'
	},
	{
		code: 'secrets.sealed',
		severity: 'error',
		means: 'the secret store needs unsealing before anything can read it',
		repair: null,
		button: 'bastion secrets unseal'
	},
	{
		code: 'secrets.rotation_overdue',
		severity: 'warn',
		means: 'a secret is older than its rotation interval',
		repair: 'observe',
		button: 'bastion secrets rotate'
	},
	{
		code: 'backup.stale',
		severity: 'error',
		means: 'no backup has been taken inside the schedule',
		repair: 'reset',
		button: 'bastion backup now'
	},
	{
		code: 'backup.verify_failed',
		severity: 'critical',
		means: 'a backup does not verify against its manifest',
		repair: null,
		button: 'bastion backup verify'
	},
	{
		code: 'backup.drill_failed',
		severity: 'error',
		means: 'a restore drill did not reproduce the page',
		repair: null,
		button: 'bastion backup drill'
	},
	{
		code: 'audit.chain_broken',
		severity: 'critical',
		means: 'the audit chain does not follow from itself',
		repair: null,
		button: 'bastion audit verify'
	},
	{
		code: 'vm.boot_failed',
		severity: 'error',
		means: 'a guest did not boot',
		repair: 'reset',
		button: 'bastion vm list'
	},
	{
		code: 'vm.hypervisor_unreachable',
		severity: 'critical',
		means: 'the hypervisor is not answering',
		repair: null,
		button: 'bastion doctor'
	},
	{
		code: 'isolation.mode_downgraded',
		severity: 'critical',
		means: 'a mechanism the configured mode needs has disappeared',
		repair: null,
		button: 'bastion doctor'
	}
];

export const BY_CODE: Record<string, Tripwire> = Object.fromEntries(
	TRIPWIRES.map((t) => [t.code, t])
);

export interface Finding {
	code: string;
	severity: LogLevel;
	scope: string;
	at: number;
	context: Record<string, unknown>;
}

export function finding(
	code: string,
	scope: string,
	at: number,
	context: Record<string, unknown> = {}
): Finding {
	const tripwire = BY_CODE[code];
	if (tripwire === undefined) {
		throw new Error(
			`${code} is not in the tripwire table; add it there rather than raising it loose`
		);
	}
	return { code, severity: tripwire.severity, scope, at, context };
}
