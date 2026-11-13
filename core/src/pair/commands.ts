import type { BastionConfig } from '../config/types';
import type { Context } from '../context';
import { BastionError } from '../errors';
import { decide } from './policy';
import { PairStore, auditPair, commandKey, type CommandRecord, type Decision } from './store';
import type { CommandClass, CommandEnvelope, CommandOutcome } from './wire';

/** a command's parameters were not what the action accepts; the message never echoes a value */
export class ParamError extends Error {}

export interface ExecResult {
	ok: boolean;
	/** a short code such as `capacity-exceeded`; never output, a path or a message */
	code: string | null;
	deploy?: { version: string; deployedAt: string } | null;
}

/**
 * One thing the control plane may ask this box to do.
 *
 * The box decides what each action is and which class it belongs to, and `params` turns the
 * command's loose parameters into the exact, validated arguments the existing operation takes. The
 * operation is the same function the CLI calls; nothing here builds a shell line.
 */
export interface Executor {
	class: CommandClass;
	params(raw: Record<string, unknown>): Record<string, string>;
	run(params: Record<string, string>): Promise<ExecResult>;
}

export type Executors = Record<string, Executor>;

export interface BookDeps {
	ctx: Context;
	config: BastionConfig;
	state: string;
	executors: Executors;
}

const OPERATOR = 'operator';
const PLANE = 'control-plane';

/**
 * Holds the commands the control plane sent, and decides what happens to each.
 *
 * A command is one command by its operation, step and idempotency key: a second delivery with the
 * same key answers with the first one's outcome and never runs again, which is what makes the
 * control plane's resend-on-reconnect safe. Every state change writes an audit line whose detail
 * is identifiers and codes, never a parameter value.
 */
export class CommandBook {
	readonly store: PairStore;
	/** commands this process is running right now, which a sweep must not mistake for a crash */
	private readonly active = new Set<string>();

	constructor(private readonly deps: BookDeps) {
		this.store = new PairStore(deps.ctx, deps.state);
	}

	private audit(
		event: string,
		principal: string,
		record: CommandRecord,
		extra: Record<string, unknown> = {}
	): void {
		const { body } = record.envelope;
		auditPair(this.deps.ctx, this.deps.state, this.deps.config.audit, {
			event,
			principal,
			level:
				event === 'pair.command.refused' || event === 'pair.command.run' ? 'warn' : 'info',
			detail: {
				id: record.id,
				opId: body.opId,
				stepId: body.stepId,
				action: body.action,
				class: record.effectiveClass,
				...extra
			}
		});
	}

	private save(record: CommandRecord): CommandRecord {
		this.store.putCommand(record);
		return record;
	}

	private finish(
		record: CommandRecord,
		outcome: CommandOutcome,
		code: string | null,
		deploy: NonNullable<CommandRecord['result']>['deploy'] = null
	): CommandRecord {
		return this.save({
			...record,
			state: 'finished',
			result: { outcome, code, deploy, at: this.deps.ctx.now() },
			reported: false
		});
	}

	/**
	 * Takes a command whose signature, node and expiry have already been verified.
	 *
	 * Returns the record, which carries the outcome to send back: `queued` while it waits, or the
	 * typed refusal when this box does not implement the action.
	 */
	async receive(envelope: CommandEnvelope): Promise<CommandRecord> {
		const { body } = envelope;
		const key = commandKey(body.opId, body.stepId, body.idempotencyKey);
		const held = this.store.findByKey(key);
		if (held !== null) {
			this.audit('pair.command.repeated', PLANE, held, { state: held.state });
			return this.save({ ...held, reported: false });
		}

		const local = this.deps.executors[body.action];
		const verdict = decide(this.deps.config, body.class, local?.class ?? null);
		const effectiveClass = verdict.verdict === 'refuse' ? body.class : verdict.effectiveClass;
		const base: CommandRecord = {
			id: this.store.freeId(key),
			key,
			envelope,
			receivedAt: this.deps.ctx.now(),
			effectiveClass,
			state: 'queued',
			result: null,
			reported: false
		};
		this.audit('pair.command.received', PLANE, base, {
			named: body.class,
			approval: body.approval,
			params: Object.keys(body.params).sort()
		});

		if (verdict.verdict === 'refuse' || local === undefined) {
			const refused = this.finish(base, 'rejected', 'unsupported_action');
			this.audit('pair.command.refused', PLANE, refused, { code: 'unsupported_action' });
			return refused;
		}
		try {
			local.params(body.params);
		} catch (error) {
			if (!(error instanceof ParamError)) throw error;
			const refused = this.finish(base, 'rejected', 'invalid_params');
			this.audit('pair.command.refused', PLANE, refused, { code: 'invalid_params' });
			return refused;
		}

		if (verdict.verdict === 'queue') {
			return this.save({
				...base,
				result: { outcome: 'queued', code: null, deploy: null, at: base.receivedAt }
			});
		}
		return this.execute(base, PLANE);
	}

	/** answers a signed command that arrived after its expiry, which is never run */
	async expire(envelope: CommandEnvelope): Promise<CommandRecord> {
		const { body } = envelope;
		const key = commandKey(body.opId, body.stepId, body.idempotencyKey);
		const held = this.store.findByKey(key);
		if (held !== null) return this.save({ ...held, reported: false });
		return this.finish(
			{
				id: this.store.freeId(key),
				key,
				envelope,
				receivedAt: this.deps.ctx.now(),
				effectiveClass: body.class,
				state: 'queued',
				result: null,
				reported: false
			},
			'expired',
			'command_expired'
		);
	}

	/** runs one command now, behind a `running` record so a crash cannot make it run twice */
	private async execute(record: CommandRecord, principal: string): Promise<CommandRecord> {
		const { body } = record.envelope;
		const local = this.deps.executors[body.action];
		if (local === undefined) return this.finish(record, 'rejected', 'unsupported_action');
		this.save({ ...record, state: 'running', reported: false });
		this.active.add(record.id);

		let result: ExecResult;
		try {
			result = await local.run(local.params(body.params));
		} catch (error) {
			result = {
				ok: false,
				code: error instanceof BastionError ? safeCode(error.code) : 'failed'
			};
		} finally {
			this.active.delete(record.id);
		}
		const done = this.finish(
			record,
			result.ok ? 'succeeded' : 'failed',
			result.ok ? null : safeCode(result.code),
			result.deploy ?? null
		);
		this.audit('pair.command.run', principal, done, {
			outcome: done.result?.outcome,
			code: done.result?.code ?? null
		});
		return done;
	}

	private queued(id: string): CommandRecord {
		const record = this.store.command(id);
		if (record === null) {
			throw new BastionError('usage', `there is no waiting command ${id}`, {
				next: 'bastion pair status'
			});
		}
		if (record.state !== 'queued') {
			throw new BastionError(
				'usage',
				`command ${id} is not waiting for approval; it is ${record.state}`,
				{
					next: 'bastion pair status'
				}
			);
		}
		return record;
	}

	/** records the operator's decision for `serve` to apply; the CLI never runs a command itself */
	decide(id: string, decision: Decision): CommandRecord {
		const record = this.queued(id);
		if (record.envelope.body.expiresAt <= this.deps.ctx.now()) {
			this.finish(record, 'expired', 'command_expired');
			throw new BastionError('usage', `command ${id} expired before it was decided`, {
				next: 'bastion pair status'
			});
		}
		this.store.decide(id, decision);
		return record;
	}

	/** applies one decision and returns the record; a command past its expiry is expired, not run */
	async apply(id: string, decision: Decision): Promise<CommandRecord | null> {
		const record = this.store.command(id);
		if (record === null || record.state !== 'queued') return null;
		if (record.envelope.body.expiresAt <= this.deps.ctx.now()) {
			return this.finish(record, 'expired', 'command_expired');
		}
		if (decision === 'reject') {
			const rejected = this.finish(record, 'rejected', 'rejected_by_operator');
			this.audit('pair.command.rejected', OPERATOR, rejected);
			return rejected;
		}
		this.audit('pair.command.approved', OPERATOR, record);
		return this.execute(record, OPERATOR);
	}

	/**
	 * The periodic pass: decisions the CLI left, queued commands that expired, runs a crash left
	 * half done, and old finished records. Returns the records whose outcome is not yet reported.
	 */
	async sweep(): Promise<CommandRecord[]> {
		const now = this.deps.ctx.now();
		for (const { id, decision } of this.store.decisions()) {
			await this.apply(id, decision);
			this.store.settle(id);
		}
		for (const record of this.store.commands()) {
			if (record.state === 'queued' && record.envelope.body.expiresAt <= now) {
				this.finish(record, 'expired', 'command_expired');
			} else if (record.state === 'running' && !this.active.has(record.id)) {
				this.finish(record, 'failed', 'interrupted');
			}
		}
		this.store.prune(now);
		return this.store.commands().filter((record) => !record.reported);
	}

	markReported(id: string): void {
		const record = this.store.command(id);
		if (record !== null && !record.reported) this.save({ ...record, reported: true });
	}
}

/** a result code the contract accepts, or `failed` when the real one would not pass */
function safeCode(code: string | null): string | null {
	if (code === null) return null;
	return /^[A-Za-z0-9._-]{1,64}$/.test(code) ? code : 'failed';
}
