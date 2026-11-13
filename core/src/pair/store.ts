import { createHash } from 'node:crypto';
import { AuditLog } from '../audit/log';
import type { AuditConfig, LogLevel } from '../config/types';
import type { Context } from '../context';
import type { SecretStore } from '../secrets/store';
import {
	fromBase64Url,
	newSeed,
	signingKeyFromSeed,
	toBase64Url,
	type CommandClass,
	type CommandEnvelope,
	type CommandOutcome,
	type SigningKey
} from './wire';

/** where the node's signing seed lives in the secrets driver, never in the config */
export const NODE_KEY_SECRET = 'fleet-node-key';

export interface PairingRecord {
	nodeId: string;
	/** where the outbound socket connects, as the control plane answered at claim */
	linkUrl: string;
	/** the control plane's public key, pinned at claim; every command is verified against it */
	dashboardPublicKey: string;
	nodePublicKey: string;
	pairedAt: number;
	/**
	 * Control plane site ids by host, which a usage report is keyed on.
	 *
	 * Empty at claim. The control plane sends the map in a `sites` frame after `ready`, and each
	 * frame replaces the whole map, so a site it dropped stops reporting. Until a frame arrives no
	 * usage interval is built.
	 */
	siteIds: Record<string, string>;
}

export interface LinkState {
	/** the last `seq` this node used; persisted before the message is sent, so a restart cannot repeat it */
	seq: number;
	connected: boolean;
	connectedAt: number | null;
	/** when the last signed message reached the control plane's socket */
	lastMessageAt: number | null;
	/** the highest `seq` seen on a frame from the control plane, echoed as `ack` */
	ack: number;
	lastClose: { code: number; reason: string; at: number } | null;
	/** the last refusal the control plane sent, which a skewed clock or a bad signature shows up as */
	lastRefusal: { code: string; at: number } | null;
	/** set when the link will not retry on its own */
	stopped: { reason: 'revoked' | 'unsupported_version'; at: number } | null;
	/** what each kind of report last sent, so a restart does not resend everything at once */
	sentAt: Record<string, number>;
}

export const EMPTY_LINK: LinkState = {
	seq: -1,
	connected: false,
	connectedAt: null,
	lastMessageAt: null,
	ack: 0,
	lastClose: null,
	lastRefusal: null,
	stopped: null,
	sentAt: {}
};

/** `running` is written before a command starts, so a crash mid-run is never read as "not yet run" */
export type CommandState = 'queued' | 'running' | 'finished';

export interface CommandRecord {
	/** the short id `bastion pair approve` takes */
	id: string;
	/** operation, step and idempotency key, which is what makes a command one command */
	key: string;
	envelope: CommandEnvelope;
	receivedAt: number;
	/** the stricter of the class the control plane named and the class this box holds the action in */
	effectiveClass: CommandClass;
	state: CommandState;
	result: {
		outcome: CommandOutcome;
		code: string | null;
		deploy: { version: string; deployedAt: string } | null;
		at: number;
	} | null;
	/** whether the control plane has been told the current outcome */
	reported: boolean;
}

export const commandKey = (opId: string, stepId: string, idempotencyKey: string): string =>
	`${opId}|${stepId}|${idempotencyKey}`;

export function commandId(key: string, length = 10): string {
	return createHash('sha256').update(key).digest('hex').slice(0, length);
}

/** how long a finished command is kept after it expires, for `pair status` to show */
const KEEP_FINISHED_MS = 24 * 3_600_000;
const MAX_RECORDS = 500;

export type Decision = 'approve' | 'reject';

/**
 * Everything pairing keeps on disk, under `<state>/pair`.
 *
 * Files rather than one database because two processes touch it: `serve` holds the socket and
 * writes the link state and command results, and the CLI writes the pairing record and the
 * operator's decisions. Each file has one writer, which is what keeps the two from overwriting each
 * other. A decision is its own file for the same reason: `pair approve` never rewrites a command
 * record that `serve` may be updating.
 */
export class PairStore {
	private readonly dir: string;

	constructor(
		private readonly ctx: Context,
		state: string
	) {
		this.dir = `${state}/pair`;
	}

	private path(name: string): string {
		return `${this.dir}/${name}`;
	}

	private readJson<T>(name: string): T | null {
		const path = this.path(name);
		if (!this.ctx.files.exists(path)) return null;
		try {
			return JSON.parse(this.ctx.files.readText(path)) as T;
		} catch {
			return null;
		}
	}

	private writeJson(name: string, value: unknown): void {
		const path = this.path(name);
		this.ctx.files.writeText(path, `${JSON.stringify(value)}\n`);
		this.ctx.files.chmod(path, 0o600);
	}

	// #region the pairing

	record(): PairingRecord | null {
		return this.readJson<PairingRecord>('pairing.json');
	}

	save(record: PairingRecord): void {
		this.ctx.files.mkdirp(this.dir);
		this.writeJson('pairing.json', record);
	}

	/**
	 * Replaces the whole id map in one write, for the pairing that is still on disk.
	 *
	 * A frame that was refused never reaches here, so a refusal leaves the old map untouched. A
	 * record for another node, or none, is left alone, so a frame that outlived an `unpair` cannot
	 * bring a pairing back.
	 */
	replaceSiteIds(nodeId: string, siteIds: Record<string, string>): PairingRecord | null {
		const held = this.record();
		if (held === null || held.nodeId !== nodeId) return null;
		const next = { ...held, siteIds };
		if (JSON.stringify(held.siteIds) !== JSON.stringify(siteIds))
			this.writeJson('pairing.json', next);
		return next;
	}

	/** removes the record, the link state, every command and every pending decision */
	clear(): void {
		for (const name of ['pairing.json', 'link.json']) this.ctx.files.remove(this.path(name));
		for (const folder of ['commands', 'decisions']) {
			const path = this.path(folder);
			if (!this.ctx.files.exists(path)) continue;
			for (const entry of this.ctx.files.readDir(path)) {
				this.ctx.files.remove(`${path}/${entry.name}`);
			}
		}
	}

	// #endregion

	// #region the link

	link(): LinkState {
		return { ...EMPTY_LINK, ...(this.readJson<Partial<LinkState>>('link.json') ?? {}) };
	}

	/** writes only while a pairing exists, so a late write cannot bring back what `unpair` removed */
	patchLink(patch: Partial<LinkState>): LinkState {
		const next = { ...this.link(), ...patch };
		if (this.record() !== null) this.writeJson('link.json', next);
		return next;
	}

	/**
	 * Reserves the next `seq` and writes it down before anything is sent.
	 *
	 * `floor` is the last `seq` the control plane says it has seen, so a box that lost this file
	 * still starts above it. Writing first means a crash between the write and the send skips a
	 * number rather than repeating one.
	 */
	nextSeq(floor: number): number {
		const state = this.link();
		const seq = Math.max(state.seq, floor) + 1;
		this.patchLink({ seq });
		return seq;
	}

	// #endregion

	// #region commands

	private commandPath(id: string): string {
		return `commands/${id}.json`;
	}

	commands(): CommandRecord[] {
		const folder = this.path('commands');
		if (!this.ctx.files.exists(folder)) return [];
		const out: CommandRecord[] = [];
		for (const entry of this.ctx.files.readDir(folder)) {
			if (!entry.name.endsWith('.json')) continue;
			const record = this.readJson<CommandRecord>(`commands/${entry.name}`);
			if (record !== null) out.push(record);
		}
		return out.sort((a, b) => a.receivedAt - b.receivedAt);
	}

	command(id: string): CommandRecord | null {
		return this.readJson<CommandRecord>(this.commandPath(id));
	}

	findByKey(key: string): CommandRecord | null {
		return this.commands().find((record) => record.key === key) ?? null;
	}

	/** an id that no other command holds, longer only when two keys collide */
	freeId(key: string): string {
		for (let length = 10; length <= 32; length += 2) {
			const id = commandId(key, length);
			const held = this.command(id);
			if (held === null || held.key === key) return id;
		}
		return commandId(key, 64);
	}

	putCommand(record: CommandRecord): void {
		this.ctx.files.mkdirp(this.path('commands'));
		this.writeJson(this.commandPath(record.id), record);
	}

	/** drops finished commands whose window closed long ago, and the oldest past the cap */
	prune(now: number): void {
		const records = this.commands();
		const stale = records.filter(
			(record) =>
				record.state === 'finished' &&
				record.reported &&
				record.envelope.body.expiresAt + KEEP_FINISHED_MS < now
		);
		for (const record of stale) this.ctx.files.remove(this.path(this.commandPath(record.id)));
		const finished = records.filter((r) => r.state === 'finished' && !stale.includes(r));
		for (const record of finished.slice(
			0,
			Math.max(0, records.length - stale.length - MAX_RECORDS)
		)) {
			this.ctx.files.remove(this.path(this.commandPath(record.id)));
		}
	}

	// #endregion

	// #region decisions

	decide(id: string, decision: Decision): void {
		this.ctx.files.mkdirp(this.path('decisions'));
		this.ctx.files.writeText(this.path(`decisions/${id}`), decision);
	}

	/** every decision waiting for `serve` to apply it */
	decisions(): { id: string; decision: Decision }[] {
		const folder = this.path('decisions');
		if (!this.ctx.files.exists(folder)) return [];
		const out: { id: string; decision: Decision }[] = [];
		for (const entry of this.ctx.files.readDir(folder)) {
			const text = this.ctx.files.readText(`${folder}/${entry.name}`).trim();
			if (text === 'approve' || text === 'reject')
				out.push({ id: entry.name, decision: text });
		}
		return out;
	}

	settle(id: string): void {
		this.ctx.files.remove(this.path(`decisions/${id}`));
	}

	// #endregion
}

/** the node's signing key, held in whichever secrets driver the operator configured */
export class NodeKey {
	constructor(private readonly secrets: SecretStore) {}

	async load(): Promise<SigningKey | null> {
		const seed = await this.secrets.get(NODE_KEY_SECRET);
		return seed === null ? null : signingKeyFromSeed(fromBase64Url(seed));
	}

	async create(): Promise<SigningKey> {
		const seed = newSeed();
		await this.secrets.set(NODE_KEY_SECRET, toBase64Url(seed));
		return signingKeyFromSeed(seed);
	}

	async remove(): Promise<void> {
		await this.secrets.remove(NODE_KEY_SECRET);
	}
}

/**
 * One audit line for a pairing event.
 *
 * A fresh log object per event, because the CLI and `serve` both append to `audit.ndjson` and a
 * log held open from startup would continue a chain the other process has already extended.
 */
export function auditPair(
	ctx: Context,
	state: string,
	config: AuditConfig,
	event: {
		event: string;
		principal: string;
		level?: LogLevel;
		detail?: Record<string, unknown>;
	}
): void {
	new AuditLog(ctx, `${state}/audit.ndjson`, config).record({
		at: ctx.now(),
		event: event.event,
		level: event.level ?? 'info',
		principal: event.principal,
		...(event.detail === undefined ? {} : { detail: event.detail })
	});
}
