import { describe, expect, it } from 'vitest';
import { AuditLog } from '../../../src/audit/log';
import { DEFAULT_PAIRING } from '../../../src/config/defaults';
import type { BastionConfig, PairingConfig } from '../../../src/config/types';
import { validate } from '../../../src/config/validate';
import { BastionError } from '../../../src/errors';
import { CommandBook, ParamError, type Executors } from '../../../src/pair/commands';
import { approvalFor, decide, stricter } from '../../../src/pair/policy';
import { PairStore, commandId, commandKey } from '../../../src/pair/store';
import type { CommandBody, CommandEnvelope } from '../../../src/pair/wire';
import { ControlPlane, NODE_ID, newBox, type Box } from './plane';

function pairing(over: Partial<PairingConfig['commands']> = {}): PairingConfig {
	return { ...DEFAULT_PAIRING, commands: { ...DEFAULT_PAIRING.commands, ...over } };
}

function setup(commands: Partial<PairingConfig['commands']> = {}) {
	const box = newBox({ pairing: pairing(commands) });
	const plane = new ControlPlane({ now: () => box.clock.now, nodePublicKey: 'unused' });
	const calls: string[] = [];
	let outcome: { ok: boolean; code: string | null } = { ok: true, code: null };
	let slow: (() => void) | null = null;
	const executors: Executors = {
		'health.observe': {
			class: 'safe',
			params: () => ({}),
			run: async () => {
				calls.push('observe');
				return outcome;
			}
		},
		'tenant.reload': {
			class: 'rebuild',
			params: () => ({}),
			run: async () => {
				calls.push('reload');
				await new Promise<void>((resolve) => (slow = resolve));
				return { ok: true, code: null };
			}
		},
		'backup.now': {
			class: 'stateful',
			params: () => ({}),
			run: async () => {
				calls.push('backup');
				throw new BastionError('capability-refused', 'backups are encrypted');
			}
		},
		'site.deploy': {
			class: 'rebuild',
			params: (raw) => {
				if (typeof raw.host !== 'string') throw new ParamError('host');
				return { host: raw.host };
			},
			run: async () => ({ ok: false, code: 'a code with spaces that would not pass' })
		}
	};
	const book = new CommandBook({ ctx: box.ctx, config: box.config, state: box.state, executors });
	const command = (over: Partial<CommandBody> = {}, tag = 'a'): CommandEnvelope =>
		plane.command({ idempotencyKey: `idem-${tag}`, ...over }) as CommandEnvelope;
	return {
		box,
		book,
		command,
		calls,
		fail: () => (outcome = { ok: false, code: 'capacity-exceeded' }),
		release: () => slow?.(),
		audit: (b: Box = box) =>
			new AuditLog(b.ctx, `${b.state}/audit.ndjson`, b.config.audit).read()
	};
}

describe('the policy', () => {
	it('holds every class for approval by default', () => {
		const box = newBox();
		for (const name of ['safe', 'rebuild', 'stateful', 'destructive'] as const) {
			expect(approvalFor(box.config, name)).toBe('queue');
		}
	});

	it('reads auto for safe and rebuild from the config', () => {
		const box = newBox({ pairing: pairing({ safe: 'auto', rebuild: 'auto' }) });
		expect(approvalFor(box.config, 'safe')).toBe('auto');
		expect(approvalFor(box.config, 'rebuild')).toBe('auto');
	});

	it('queues stateful and destructive even when a config object says auto', () => {
		const box = newBox({
			pairing: {
				...DEFAULT_PAIRING,
				commands: { safe: 'auto', rebuild: 'auto', stateful: 'auto', destructive: 'auto' }
			}
		});
		expect(approvalFor(box.config, 'stateful')).toBe('queue');
		expect(approvalFor(box.config, 'destructive')).toBe('queue');
	});

	it('falls back to the defaults when a config has no pairing block', () => {
		const config = { ...newBox().config, pairing: undefined } as BastionConfig;
		expect(approvalFor(config, 'safe')).toBe('queue');
	});

	it('takes the stricter of the class the plane names and the class the box holds', () => {
		expect(stricter('safe', 'rebuild')).toBe('rebuild');
		expect(stricter('destructive', 'safe')).toBe('destructive');
		const box = newBox({ pairing: pairing({ safe: 'auto' }) });
		expect(decide(box.config, 'safe', 'rebuild')).toEqual({
			verdict: 'queue',
			effectiveClass: 'rebuild'
		});
		expect(decide(box.config, 'safe', 'safe')).toEqual({
			verdict: 'run',
			effectiveClass: 'safe'
		});
		expect(decide(box.config, 'safe', null)).toEqual({
			verdict: 'refuse',
			code: 'unsupported_action'
		});
	});

	it('refuses auto for a stateful or destructive class when it validates a file', () => {
		for (const name of ['stateful', 'destructive']) {
			const result = validate({ version: 1, pairing: { commands: { [name]: 'auto' } } });
			expect(result.ok).toBe(false);
			expect(result.problems[0]!.path).toBe(`pairing.commands.${name}`);
		}
	});

	it('accepts the operator settings it documents, and rejects the rest', () => {
		expect(
			validate({
				version: 1,
				pairing: {
					sendHostname: true,
					hashNames: true,
					commands: {
						safe: 'auto',
						rebuild: 'auto',
						stateful: 'queue',
						destructive: 'queue'
					}
				}
			}).ok
		).toBe(true);
		expect(validate({ version: 1, pairing: 'yes' }).ok).toBe(false);
		expect(validate({ version: 1, pairing: { sendHostname: 'yes' } }).ok).toBe(false);
		expect(validate({ version: 1, pairing: { commands: 'auto' } }).ok).toBe(false);
		expect(validate({ version: 1, pairing: { commands: { nuke: 'queue' } } }).ok).toBe(false);
		expect(validate({ version: 1, pairing: { commands: { safe: 'maybe' } } }).ok).toBe(false);
	});
});

describe('a command arriving', () => {
	it('waits for approval and answers queued', async () => {
		const { book, command, calls } = setup();
		const record = await book.receive(command());
		expect(record.state).toBe('queued');
		expect(record.result).toMatchObject({ outcome: 'queued' });
		expect(calls).toEqual([]);
	});

	it('runs at once for a class the operator set to auto', async () => {
		const { book, command, calls } = setup({ safe: 'auto' });
		const record = await book.receive(command());
		expect(record.state).toBe('finished');
		expect(record.result).toMatchObject({ outcome: 'succeeded', code: null });
		expect(calls).toEqual(['observe']);
	});

	it('does not let a mislabelled class skip the queue', async () => {
		const { book, command, calls } = setup({ safe: 'auto' });
		const record = await book.receive(command({ class: 'safe', action: 'tenant.reload' }));
		expect(record.effectiveClass).toBe('rebuild');
		expect(record.state).toBe('queued');
		expect(calls).toEqual([]);
	});

	it('reports a failure with the box error code and nothing else', async () => {
		const { book, command, fail } = setup({ safe: 'auto' });
		fail();
		const record = await book.receive(command());
		expect(record.result).toMatchObject({ outcome: 'failed', code: 'capacity-exceeded' });
	});

	it('turns a thrown error into a code and never its message', async () => {
		const { book, command } = setup();
		const queued = await book.receive(command({ class: 'stateful', action: 'backup.now' }));
		book.store.decide(queued.id, 'approve');
		await book.sweep();
		const done = book.store.command(queued.id)!;
		expect(done.result).toMatchObject({ outcome: 'failed', code: 'capability-refused' });
		expect(JSON.stringify(done.result)).not.toContain('encrypted');
	});

	it('replaces a result code the contract would reject with failed', async () => {
		const { book, command } = setup();
		const queued = await book.receive(
			command({ class: 'rebuild', action: 'site.deploy', params: { host: 'a.example.edu' } })
		);
		book.store.decide(queued.id, 'approve');
		await book.sweep();
		expect(book.store.command(queued.id)!.result).toMatchObject({
			outcome: 'failed',
			code: 'failed'
		});
	});

	it('answers a typed refusal for an action it does not implement', async () => {
		const { book, command, calls } = setup({ safe: 'auto' });
		const record = await book.receive(command({ action: 'site.erase', class: 'destructive' }));
		expect(record.result).toMatchObject({ outcome: 'rejected', code: 'unsupported_action' });
		expect(calls).toEqual([]);
	});

	it('answers a typed refusal for parameters the action rejects', async () => {
		const { book, command } = setup();
		const record = await book.receive(
			command({ class: 'rebuild', action: 'site.deploy', params: { host: ['--flag'] } })
		);
		expect(record.result).toMatchObject({ outcome: 'rejected', code: 'invalid_params' });
	});

	it('repeats the first answer for a repeated idempotency key and runs nothing again', async () => {
		const { book, command, calls } = setup({ safe: 'auto' });
		const first = await book.receive(command());
		const again = await book.receive(command());
		expect(again.id).toBe(first.id);
		expect(again.result).toEqual(first.result);
		expect(again.reported).toBe(false);
		expect(calls).toEqual(['observe']);
		expect(book.store.commands()).toHaveLength(1);
	});

	it('treats the same key under another operation as another command', async () => {
		const { book, command, calls } = setup({ safe: 'auto' });
		await book.receive(command({}, 'same'));
		await book.receive(command({ opId: 'op_testop000002' }, 'same'));
		expect(calls).toEqual(['observe', 'observe']);
	});

	it('gives each command a short id from its key and extends it on a collision', async () => {
		const { book, command, box } = setup();
		const first = await book.receive(command());
		expect(first.id).toBe(commandId(commandKey('op_testop000001', 'step-1', 'idem-a')));
		expect(first.id).toHaveLength(10);
		const store = new PairStore(box.ctx, box.state);
		store.putCommand({ ...first, id: commandId('other|key|x'), key: 'other|key|x' });
		expect(store.freeId('other|key|x')).toBe(commandId('other|key|x'));
		store.putCommand({ ...first, id: commandId('rival|key|y'), key: 'someone|else|z' });
		expect(store.freeId('rival|key|y')).toHaveLength(commandId('rival|key|y', 12).length);
	});
});

describe('approving and rejecting', () => {
	it('runs a queued command once when it is approved', async () => {
		const { book, command, calls } = setup();
		const queued = await book.receive(command());
		book.decide(queued.id, 'approve');
		const pending = await book.sweep();
		expect(calls).toEqual(['observe']);
		expect(pending.map((record) => record.result?.outcome)).toEqual(['succeeded']);
		expect(book.store.decisions()).toEqual([]);
		await book.sweep();
		expect(calls).toEqual(['observe']);
	});

	it('answers rejected, without running it, when it is rejected', async () => {
		const { book, command, calls } = setup();
		const queued = await book.receive(command());
		book.decide(queued.id, 'reject');
		await book.sweep();
		expect(book.store.command(queued.id)!.result).toMatchObject({
			outcome: 'rejected',
			code: 'rejected_by_operator'
		});
		expect(calls).toEqual([]);
	});

	it('refuses a decision for an id that is not waiting', async () => {
		const { book, command } = setup({ safe: 'auto' });
		const done = await book.receive(command());
		expect(() => book.decide('nosuchid00', 'approve')).toThrow('no waiting command');
		expect(() => book.decide(done.id, 'approve')).toThrow('not waiting for approval');
	});

	it('refuses to decide a command that already expired, and marks it expired', async () => {
		const { book, command, box } = setup();
		const queued = await book.receive(command({ expiresAt: box.clock.now + 1000 }));
		box.clock.now += 2000;
		expect(() => book.decide(queued.id, 'approve')).toThrow('expired');
		expect(book.store.command(queued.id)!.result).toMatchObject({ outcome: 'expired' });
	});

	it('expires, instead of running, a command approved after its time ran out', async () => {
		const { book, command, calls, box } = setup();
		const queued = await book.receive(command({ expiresAt: box.clock.now + 1000 }));
		book.decide(queued.id, 'approve');
		box.clock.now += 2000;
		await book.sweep();
		expect(book.store.command(queued.id)!.result).toMatchObject({
			outcome: 'expired',
			code: 'command_expired'
		});
		expect(calls).toEqual([]);
	});

	it('does not mistake a command it is still running for one a crash left half done', async () => {
		const { book, command, release, calls } = setup({ rebuild: 'auto' });
		const running = book.receive(command({ class: 'rebuild', action: 'tenant.reload' }));
		await new Promise((resolve) => setImmediate(resolve));
		await book.sweep();
		expect(book.store.commands()[0]!.state).toBe('running');
		release();
		const done = await running;
		expect(done.result).toMatchObject({ outcome: 'succeeded' });
		expect(calls).toEqual(['reload']);
	});

	it('marks a run a crash left half done as interrupted and does not run it again', async () => {
		const { book, command, box, calls } = setup();
		const queued = await book.receive(command());
		new PairStore(box.ctx, box.state).putCommand({ ...queued, state: 'running', result: null });
		await book.sweep();
		expect(book.store.command(queued.id)!.result).toMatchObject({
			outcome: 'failed',
			code: 'interrupted'
		});
		await book.sweep();
		expect(calls).toEqual([]);
	});

	it('answers a signed command that arrived after its expiry, once', async () => {
		const { book, command, box } = setup();
		const late = command({ expiresAt: box.clock.now - 1 });
		const record = await book.expire(late);
		expect(record.result).toMatchObject({ outcome: 'expired', code: 'command_expired' });
		const again = await book.expire(late);
		expect(again.id).toBe(record.id);
		expect(book.store.commands()).toHaveLength(1);
	});
});

describe('the audit trail of a command', () => {
	it('records receipt, approval and the run with identifiers and codes only', async () => {
		const { book, command, audit } = setup();
		const queued = await book.receive(
			command({
				class: 'rebuild',
				action: 'site.deploy',
				params: { host: 'private-host.example.edu' }
			})
		);
		book.decide(queued.id, 'approve');
		await book.sweep();
		const entries = audit();
		expect(entries.map((entry) => entry.event)).toEqual([
			'pair.command.received',
			'pair.command.approved',
			'pair.command.run'
		]);
		expect(entries.map((entry) => entry.principal)).toEqual([
			'control-plane',
			'operator',
			'operator'
		]);
		expect(JSON.stringify(entries)).not.toContain('private-host');
	});

	it('records a rejection and a refusal', async () => {
		const { book, command, audit } = setup();
		const queued = await book.receive(command({}, 'one'));
		book.decide(queued.id, 'reject');
		await book.receive(command({ action: 'nope' }, 'two'));
		await book.sweep();
		expect(audit().map((entry) => entry.event)).toEqual([
			'pair.command.received',
			'pair.command.received',
			'pair.command.refused',
			'pair.command.rejected'
		]);
	});

	it('records a repeated delivery without running it', async () => {
		const { book, command, audit } = setup({ safe: 'auto' });
		await book.receive(command());
		await book.receive(command());
		expect(audit().map((entry) => entry.event)).toContain('pair.command.repeated');
	});
});

describe('the store', () => {
	it('keeps finished commands until their window closed long ago, and open ones always', async () => {
		const { book, command, box } = setup({ safe: 'auto' });
		const done = await book.receive(command({ expiresAt: box.clock.now + 1000 }, 'done'));
		book.markReported(done.id);
		const waiting = await book.receive(
			command(
				{ action: 'tenant.reload', class: 'rebuild', expiresAt: box.clock.now + 1000 },
				'wait'
			)
		);
		box.clock.now += 1000 + 25 * 3_600_000;
		const store = new PairStore(box.ctx, box.state);
		store.prune(box.clock.now);
		expect(store.command(done.id)).toBeNull();
		expect(store.command(waiting.id)).not.toBeNull();
	});

	it('survives a torn link file by reading the defaults', async () => {
		const { box } = setup();
		const store = new PairStore(box.ctx, box.state);
		box.files.writeText(`${box.state}/pair/link.json`, '{"seq": 4');
		expect(store.link().seq).toBe(-1);
	});

	it('clears the record, the link state, the commands and the decisions together', async () => {
		const { box, book, command } = setup();
		const store = new PairStore(box.ctx, box.state);
		store.save({
			nodeId: NODE_ID,
			linkUrl: 'wss://link.example.edu/link/nod_testnode0001',
			dashboardPublicKey: 'x'.repeat(43),
			nodePublicKey: 'y'.repeat(43),
			pairedAt: 1,
			siteIds: {}
		});
		store.patchLink({ seq: 9 });
		const queued = await book.receive(command());
		store.decide(queued.id, 'approve');
		store.clear();
		expect(store.record()).toBeNull();
		expect(store.link().seq).toBe(-1);
		expect(store.commands()).toEqual([]);
		expect(store.decisions()).toEqual([]);
	});

	it('does not write link state once the pairing is gone', () => {
		const { box } = setup();
		const store = new PairStore(box.ctx, box.state);
		store.patchLink({ seq: 3 });
		expect(box.files.exists(`${box.state}/pair/link.json`)).toBe(false);
	});
});
