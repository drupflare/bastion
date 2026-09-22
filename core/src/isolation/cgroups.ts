import type { TenantLimits } from '../config/types';
import type { Context } from '../context';

/** where bastion puts its own tree, so it never writes into the operator's slices */
export const CGROUP_ROOT = '/sys/fs/cgroup/bastion.slice';

export function cgroupPath(tenant: string, root = CGROUP_ROOT): string {
	return `${root}/tenant-${tenant}`;
}

/** `cpu.max` as the pair the kernel wants: quota and period, both microseconds */
export function cpuMax(cpu: string | undefined, periodUs = 100_000): string {
	if (cpu === undefined || cpu.trim() === '') return 'max 100000';
	const cores = Number(cpu);
	if (!Number.isFinite(cores) || cores <= 0) return 'max 100000';
	return `${Math.round(cores * periodUs)} ${periodUs}`;
}

export interface CgroupWrites {
	path: string;
	files: Record<string, string>;
}

/**
 * The limit files for one tenant.
 *
 * This is where the isolate-memory row of the limits table actually binds, and the granularity is
 * the reason it reads `declared per isolate, enforced per tenant`: a tenant holds N sites in one
 * workerd process, so the cgroup bounds the PROCESS. One site can consume the whole tenant budget
 * and no per-isolate cap exists anywhere in standalone workerd.
 *
 * `memory.oom.group` is the half that matters under pressure. Without it the kernel kills the
 * largest task and the rest of the tenant keeps running half-dead; with it the whole tenant goes
 * and every other tenant on the box is untouched.
 */
export function cgroupWrites(
	tenant: string,
	limits: TenantLimits = {},
	root = CGROUP_ROOT
): CgroupWrites {
	const files: Record<string, string> = {
		'cpu.max': cpuMax(limits.cpu),
		'memory.max': limits.memory === undefined ? 'max' : String(limits.memory),
		'pids.max': limits.pids === undefined ? 'max' : String(limits.pids),
		'memory.oom.group': '1'
	};
	if (limits.memory !== undefined) {
		// reclaim before the hard wall rather than at it, so a spike sheds page cache instead of
		// taking the tenant with it
		files['memory.high'] = String(Math.floor(limits.memory * 0.9));
	}
	return { path: cgroupPath(tenant, root), files };
}

export function applyCgroup(
	ctx: Context,
	tenant: string,
	limits: TenantLimits = {},
	root = CGROUP_ROOT
): CgroupWrites {
	const writes = cgroupWrites(tenant, limits, root);
	ctx.files.mkdirp(writes.path);
	for (const [name, value] of Object.entries(writes.files)) {
		ctx.files.writeText(`${writes.path}/${name}`, value);
	}
	return writes;
}

/** moves a started process into the tenant's cgroup; the pid is written after the spawn */
export function attachPid(ctx: Context, tenant: string, pid: number, root = CGROUP_ROOT): void {
	ctx.files.writeText(`${cgroupPath(tenant, root)}/cgroup.procs`, String(pid));
}

export interface CgroupUsage {
	memoryBytes: number | null;
	memoryPeakBytes: number | null;
	cpuUsec: number | null;
	oomKills: number;
	underPressure: boolean;
}

function readNumber(ctx: Context, path: string): number | null {
	if (!ctx.files.exists(path)) return null;
	const value = Number(ctx.files.readText(path).trim());
	return Number.isFinite(value) ? value : null;
}

/**
 * What a tenant is costing, read from the cgroup rather than from `dmesg`.
 *
 * `memory.events` carries the `oom_kill` counter and the `high` pressure counter, which is a
 * reading; scraping the kernel log for an OOM line is a parse of someone else's format that also
 * misses everything rotated away.
 */
export function cgroupUsage(ctx: Context, tenant: string, root = CGROUP_ROOT): CgroupUsage {
	const path = cgroupPath(tenant, root);
	const events = ctx.files.exists(`${path}/memory.events`)
		? ctx.files.readText(`${path}/memory.events`)
		: '';
	const counter = (name: string): number => {
		const line = events.split('\n').find((l) => l.startsWith(`${name} `));
		return line === undefined ? 0 : Number(line.split(' ')[1] ?? 0);
	};
	const cpuStat = ctx.files.exists(`${path}/cpu.stat`)
		? ctx.files.readText(`${path}/cpu.stat`)
		: '';
	const usage = cpuStat.split('\n').find((l) => l.startsWith('usage_usec '));
	return {
		memoryBytes: readNumber(ctx, `${path}/memory.current`),
		memoryPeakBytes: readNumber(ctx, `${path}/memory.peak`),
		cpuUsec: usage === undefined ? null : Number(usage.split(' ')[1] ?? 0),
		oomKills: counter('oom_kill'),
		underPressure: counter('high') > 0 || counter('max') > 0
	};
}
