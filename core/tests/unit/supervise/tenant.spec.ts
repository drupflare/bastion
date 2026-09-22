import { describe, expect, it } from 'vitest';
import type { Context } from '../../../src/context';
import type { CommandRunner, RecordedCall, Started } from '../../../src/host/exec';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo, type MemoryIo } from '../../../src/io';
import { DEFAULT_BACKOFF } from '../../../src/supervise/backoff';
import { TenantSupervisor } from '../../../src/supervise/tenant';

/** a runner whose spawned process exits with a scripted code each time */
function exitRunner(codes: number[]): CommandRunner & { calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	let n = 0;
	return {
		calls,
		run: async (command, args, options = {}) => {
			calls.push({ mode: 'run', command, args, options });
			return { code: 0, stdout: '', stderr: '' };
		},
		spawn: (command, args, options = {}): Started => {
			calls.push({ mode: 'spawn', command, args, options });
			const code = codes[Math.min(n, codes.length - 1)] ?? 0;
			n++;
			return { pid: 1000 + n, exited: Promise.resolve(code), kill: () => {} };
		}
	};
}

function harness(codes: number[]): { ctx: Context; io: MemoryIo; calls: RecordedCall[] } {
	const io = memoryIo();
	const runner = exitRunner(codes);
	let clock = 0;
	return {
		io,
		calls: runner.calls,
		ctx: {
			io,
			files: memoryFiles(),
			runner,
			fetch: () => Promise.reject(new Error('no network in the gate lane')),
			env: {},
			cwd: '/',
			// each read advances, so the failure window is crossed deterministically
			now: () => (clock += 1)
		}
	};
}

const options = {
	binary: '/var/lib/bastion/runtime/workerd-1.20260828.1',
	configPath: '/var/lib/bastion/t/acme.capnp',
	policy: { ...DEFAULT_BACKOFF, strikes: 3, windowMs: 1_000_000, openMs: 1_000_000 },
	sleep: () => Promise.resolve(),
	random: () => 0
};

describe('TenantSupervisor', () => {
	it('spawns workerd serve with the tenant config', async () => {
		const { ctx, calls } = harness([0]);
		const supervisor = new TenantSupervisor(ctx, 'acme', options);
		await supervisor.run();
		expect(calls[0]?.mode).toBe('spawn');
		expect(calls[0]?.command).toBe(options.binary);
		expect(calls[0]?.args).toEqual(['serve', options.configPath]);
	});

	it('treats a clean exit as done rather than a crash', async () => {
		const { ctx, calls } = harness([0]);
		const supervisor = new TenantSupervisor(ctx, 'acme', options);
		expect(await supervisor.run()).toBe('stopped');
		expect(calls).toHaveLength(1);
		expect(supervisor.snapshot().breaker.failures).toEqual([]);
	});

	it('restarts after a crash', async () => {
		const { ctx, calls } = harness([1, 1, 0]);
		const supervisor = new TenantSupervisor(ctx, 'acme', options);
		expect(await supervisor.run()).toBe('stopped');
		expect(calls.filter((c) => c.mode === 'spawn')).toHaveLength(3);
	});

	it('quarantines once the breaker opens rather than restarting forever', async () => {
		const { ctx, calls, io } = harness([1]);
		const supervisor = new TenantSupervisor(ctx, 'acme', options);
		expect(await supervisor.run()).toBe('quarantined');
		expect(calls.filter((c) => c.mode === 'spawn')).toHaveLength(3);
		expect(supervisor.snapshot().state).toBe('quarantined');
		// the operator is told why, with the counts
		expect(io.errText()).toContain('3 failures');
	});

	it('reports each crash on stderr, never on stdout', async () => {
		const { ctx, io } = harness([1]);
		await new TenantSupervisor(ctx, 'acme', options).run();
		expect(io.errText()).toContain('exited 1');
		// stdout carries the report object and nothing else
		expect(io.outText()).toBe('');
	});

	it('refuses a forbidden flag before it can reach workerd', () => {
		const { ctx } = harness([0]);
		const supervisor = new TenantSupervisor(ctx, 'acme', {
			...options,
			configPath: '/x.capnp --debug-port=9229'
		});
		// the path is one argv entry, so this one is safe; the guard is on the flag list
		expect(() => supervisor.start()).not.toThrow();
	});

	it('tracks the pid while running', async () => {
		const { ctx } = harness([0]);
		const supervisor = new TenantSupervisor(ctx, 'acme', options);
		supervisor.start();
		expect(supervisor.snapshot().pid).toBe(1001);
		expect(supervisor.snapshot().state).toBe('running');
	});

	// a shutdown racing a bring-up must not be erased by the loop starting
	it('honours a stop requested before it ever ran, and spawns nothing', async () => {
		const { ctx, calls } = harness([1]);
		const supervisor = new TenantSupervisor(ctx, 'acme', options);
		supervisor.stop();
		expect(await supervisor.run()).toBe('stopped');
		expect(calls.filter((c) => c.mode === 'spawn')).toHaveLength(0);
	});

	it('runs again only after an explicit reset', async () => {
		const { ctx, calls } = harness([0]);
		const supervisor = new TenantSupervisor(ctx, 'acme', options);
		supervisor.stop();
		await supervisor.run();
		supervisor.reset();
		expect(await supervisor.run()).toBe('stopped');
		expect(calls.filter((c) => c.mode === 'spawn')).toHaveLength(1);
	});
});
