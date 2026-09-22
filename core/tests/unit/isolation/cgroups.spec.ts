import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import {
	applyCgroup,
	attachPid,
	cgroupPath,
	cgroupUsage,
	cgroupWrites,
	cpuMax
} from '../../../src/isolation/cgroups';

function ctx(files = memoryFiles()) {
	return { ...defaultContext(), files, io: memoryIo(), env: {} };
}

describe('cpuMax', () => {
	it('turns a core count into a quota and a period', () => {
		expect(cpuMax('2')).toBe('200000 100000');
		expect(cpuMax('0.5')).toBe('50000 100000');
	});

	it('means unlimited when unset or nonsense, never zero', () => {
		expect(cpuMax(undefined)).toBe('max 100000');
		expect(cpuMax('')).toBe('max 100000');
		expect(cpuMax('-1')).toBe('max 100000');
		expect(cpuMax('lots')).toBe('max 100000');
	});
});

describe('cgroupWrites', () => {
	it('writes under bastion s own slice, never the operator s', () => {
		expect(cgroupPath('acme')).toBe('/sys/fs/cgroup/bastion.slice/tenant-acme');
	});

	it('kills the whole tenant on OOM rather than its largest task', () => {
		expect(cgroupWrites('acme').files['memory.oom.group']).toBe('1');
	});

	it('sets a reclaim point below the hard wall', () => {
		const writes = cgroupWrites('acme', { memory: 1000 });
		expect(writes.files['memory.high']).toBe('900');
		expect(writes.files['memory.max']).toBe('1000');
	});

	it('leaves an unset limit unlimited rather than defaulting to a number', () => {
		const writes = cgroupWrites('acme');
		expect(writes.files['memory.max']).toBe('max');
		expect(writes.files['pids.max']).toBe('max');
		expect(writes.files['memory.high']).toBeUndefined();
	});
});

describe('applyCgroup', () => {
	it('writes every limit file into the tenant s own directory', () => {
		const files = memoryFiles();
		applyCgroup(ctx(files), 'acme', { cpu: '2', memory: 4096, pids: 512 });
		const path = cgroupPath('acme');
		expect(files.readText(`${path}/cpu.max`)).toBe('200000 100000');
		expect(files.readText(`${path}/memory.max`)).toBe('4096');
		expect(files.readText(`${path}/pids.max`)).toBe('512');
	});

	it('attaches a pid after the spawn, which is the only order that works', () => {
		const files = memoryFiles();
		applyCgroup(ctx(files), 'acme');
		attachPid(ctx(files), 'acme', 4242);
		expect(files.readText(`${cgroupPath('acme')}/cgroup.procs`)).toBe('4242');
	});
});

describe('cgroupUsage', () => {
	it('reads the OOM counter from memory.events rather than from the kernel log', () => {
		const files = memoryFiles({
			[`${cgroupPath('acme')}/memory.events`]: 'low 0\nhigh 4\nmax 2\noom 1\noom_kill 3\n',
			[`${cgroupPath('acme')}/memory.current`]: '12345\n',
			[`${cgroupPath('acme')}/cpu.stat`]: 'usage_usec 987\nuser_usec 500\n'
		});
		const usage = cgroupUsage(ctx(files), 'acme');
		expect(usage.oomKills).toBe(3);
		expect(usage.underPressure).toBe(true);
		expect(usage.memoryBytes).toBe(12345);
		expect(usage.cpuUsec).toBe(987);
	});

	it('answers null rather than zero where the file is absent', () => {
		const usage = cgroupUsage(ctx(), 'acme');
		expect(usage.memoryBytes).toBe(null);
		expect(usage.cpuUsec).toBe(null);
		expect(usage.oomKills).toBe(0);
	});
});
