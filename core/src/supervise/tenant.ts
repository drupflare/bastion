import type { Context } from '../context';
import type { Started } from '../host/exec';
import { serveArgv } from '../workerd/binary';
import {
	beginTrial,
	DEFAULT_BACKOFF,
	delayFor,
	mayStart,
	newBreaker,
	recordFailure,
	recordSuccess,
	type BackoffPolicy,
	type Breaker
} from './backoff';

export type TenantState = 'stopped' | 'starting' | 'running' | 'backoff' | 'quarantined';

export interface TenantProcess {
	tenant: string;
	state: TenantState;
	pid: number | null;
	/** how many times it has been started since the last clean run */
	attempts: number;
	breaker: Breaker;
	startedAt: number | null;
}

export interface SupervisorOptions {
	binary: string;
	/** the generated config.capnp for this tenant */
	configPath: string;
	policy?: BackoffPolicy;
	/** seam so a spec drives the schedule without waiting */
	sleep?(ms: number): Promise<void>;
	random?(): number;
}

/**
 * One workerd process per tenant.
 *
 * Per tenant rather than per host, in EVERY mode. That is what makes a cgroup limit actually bind
 * to something, lets a tenant change restart one tenant instead of the box, and keeps a Durable
 * Object consistency domain per tenant. workerd has no live config reload -- `--watch` execs the
 * binary over itself and drops all in-memory object state -- so a reload here is a process swap.
 */
export class TenantSupervisor {
	readonly tenant: string;
	private readonly ctx: Context;
	private readonly options: Required<Pick<SupervisorOptions, 'binary' | 'configPath'>> &
		SupervisorOptions;
	private readonly policy: BackoffPolicy;
	private process: TenantProcess;
	private running: Started | null = null;
	private stopping = false;

	constructor(ctx: Context, tenant: string, options: SupervisorOptions) {
		this.ctx = ctx;
		this.tenant = tenant;
		this.options = options;
		this.policy = options.policy ?? DEFAULT_BACKOFF;
		this.process = {
			tenant,
			state: 'stopped',
			pid: null,
			attempts: 0,
			breaker: newBreaker(),
			startedAt: null
		};
	}

	snapshot(): TenantProcess {
		return { ...this.process, breaker: { ...this.process.breaker } };
	}

	/** starts the process once; the caller drives the restart loop */
	start(): Started {
		const argv = serveArgv(this.options.configPath);
		const started = this.ctx.runner.spawn(this.options.binary, argv);
		this.running = started;
		this.process = {
			...this.process,
			state: 'running',
			pid: started.pid,
			attempts: this.process.attempts + 1,
			startedAt: this.ctx.now()
		};
		return started;
	}

	/**
	 * Runs the tenant until it is stopped or the breaker opens.
	 *
	 * Resolves with the terminal state, so a caller can report `quarantined` rather than having to
	 * infer it from a process that stopped coming back.
	 */
	async run(): Promise<TenantState> {
		// a stop requested BEFORE the loop starts is honoured rather than cleared. Resetting the
		// flag here meant a shutdown racing a bring-up was erased and the tenant came back up.
		if (this.stopping) {
			this.process = { ...this.process, state: 'stopped', pid: null };
			return 'stopped';
		}
		for (;;) {
			const now = this.ctx.now();
			if (!mayStart(this.process.breaker, now, this.policy)) {
				this.process = { ...this.process, state: 'quarantined' };
				return 'quarantined';
			}
			if (this.process.breaker.state === 'open') {
				this.process = { ...this.process, breaker: beginTrial(this.process.breaker, now) };
			}

			const started = this.start();
			const code = await started.exited;
			this.running = null;

			if (this.stopping) {
				this.process = { ...this.process, state: 'stopped', pid: null };
				return 'stopped';
			}

			if (code === 0) {
				// a clean exit is not a crash; the operator asked for it or workerd finished
				this.process = {
					...this.process,
					state: 'stopped',
					pid: null,
					attempts: 0,
					breaker: recordSuccess()
				};
				return 'stopped';
			}

			const at = this.ctx.now();
			const breaker = recordFailure(this.process.breaker, at, this.policy);
			this.process = { ...this.process, state: 'backoff', pid: null, breaker };
			this.ctx.io.err(
				`tenant ${this.tenant}: workerd exited ${code}, attempt ${this.process.attempts}`
			);
			if (breaker.state === 'open') {
				this.process = { ...this.process, state: 'quarantined' };
				this.ctx.io.err(
					`tenant ${this.tenant}: ${breaker.failures.length} failures in ` +
						`${this.policy.windowMs}ms, holding for ${this.policy.openMs}ms`
				);
				return 'quarantined';
			}
			await this.wait(delayFor(this.process.attempts, this.policy, this.options.random));
		}
	}

	/** asks the process to stop; `run` resolves `stopped` rather than restarting */
	stop(signal: NodeJS.Signals = 'SIGTERM'): void {
		this.stopping = true;
		this.running?.kill(signal);
	}

	/** clears a previous stop so the tenant may be run again; never implicit */
	reset(): void {
		this.stopping = false;
	}

	private wait(ms: number): Promise<void> {
		return this.options.sleep === undefined
			? new Promise((resolve) => setTimeout(resolve, ms))
			: this.options.sleep(ms);
	}
}
