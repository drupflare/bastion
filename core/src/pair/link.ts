import { randomUUID } from 'node:crypto';
import { AuditLog } from '../audit/log';
import type { BastionConfig } from '../config/types';
import type { Context } from '../context';
import type { AnalyticsWindow } from '../observe/analytics';
import type { SecretStore } from '../secrets/store';
import { assertLink, assertReachable, type EgressOptions } from './claim';
import { CommandBook, type Executors } from './commands';
import {
	auditHeadBody,
	commandResultBody,
	findingsBody,
	metricsBody,
	statusBody,
	usageBody,
	type FieldInput
} from './fields';
import { NodeKey, PairStore, auditPair, type CommandRecord, type PairingRecord } from './store';
import {
	CLOSE,
	FLEET_LINK_VERSION,
	parseChallenge,
	signChallengeResponse,
	signEnvelope,
	verifyEnvelope,
	type CommandEnvelope,
	type Envelope,
	type NodeMessageType,
	type SigningKey,
	type SitesEnvelope
} from './wire';

/** the part of a WebSocket the link uses, so a spec can drive it without a network */
export interface Socket {
	send(text: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code: number; reason: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
}

export type Connect = (url: string) => Socket;

export const defaultConnect: Connect = (url) => new WebSocket(url) as unknown as Socket;

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 60_000;
export const HANDSHAKE_WAIT_MS = 45_000;
export const STATUS_EVERY_MS = 5 * 60_000;
export const WATCH_EVERY_MS = 60_000;
export const METRICS_EVERY_MS = 5 * 60_000;
export const USAGE_EVERY_MS = 60 * 60_000;

/**
 * How long to wait before attempt `attempt`, counting from zero.
 *
 * Doubles to a cap, then takes between half and all of it: a thousand boxes that lost the control
 * plane together would otherwise all come back in the same second.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
	const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, 16));
	return Math.round(ceiling * (0.5 + random() / 2));
}

export type CloseAction = 'retry' | 'wait' | 'revoked' | 'unsupported_version';

/** what the control plane's close code asks of the box */
export function closeAction(code: number): CloseAction {
	if (code === CLOSE.revoked) return 'revoked';
	if (code === CLOSE.unsupportedVersion) return 'unsupported_version';
	// another connection took this node's place; coming straight back would trade places forever
	if (code === CLOSE.replaced) return 'wait';
	return 'retry';
}

export type Phase = 'idle' | 'connecting' | 'handshake' | 'ready' | 'backoff' | 'stopped';

export interface LinkDeps {
	ctx: Context;
	config: BastionConfig;
	state: string;
	secrets: SecretStore;
	executors: Executors;
	/** the request window `serve` holds; absent means no metrics or usage are sent */
	analytics?: AnalyticsWindow;
	connect?: Connect;
	resolve?: EgressOptions['resolve'];
	random?: () => number;
	/** runs `fn` after `ms` and returns a way to cancel it */
	schedule?: (fn: () => void, ms: number) => () => void;
	hostname?: string;
	arch?: string;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
	const timer = setTimeout(fn, ms);
	timer.unref?.();
	return () => clearTimeout(timer);
};

/**
 * The outbound link to the control plane.
 *
 * It dials, answers the signed challenge, then sends signed reports with a strictly rising `seq`
 * and verifies and files every command it is sent. It never listens: there is no server socket
 * here, which is the outbound-only posture the manual states. `sync` is called on `serve`'s timer
 * and is what starts the link after `pair`, stops it after `unpair`, and carries every periodic
 * report, so the CLI never has to reach into the running process.
 */
export class FleetLink {
	private readonly store: PairStore;
	private readonly book: CommandBook;
	private readonly connect: Connect;
	private readonly schedule: NonNullable<LinkDeps['schedule']>;
	private socket: Socket | null = null;
	private phase: Phase = 'idle';
	private attempt = 0;
	private floor = -1;
	private key: SigningKey | null = null;
	private record: PairingRecord | null = null;
	private cancelRetry: (() => void) | null = null;
	private cancelHandshake: (() => void) | null = null;
	private closing = false;
	private pending = false;
	private tail: Promise<unknown> = Promise.resolve();
	private lastFindings = '';
	private lastAuditSeq = -1;

	constructor(private readonly deps: LinkDeps) {
		this.store = new PairStore(deps.ctx, deps.state);
		this.book = new CommandBook(deps);
		this.connect = deps.connect ?? defaultConnect;
		this.schedule = deps.schedule ?? defaultSchedule;
	}

	get current(): Phase {
		return this.phase;
	}

	private say(line: string): void {
		this.deps.ctx.io.err(`pairing: ${line}`);
	}

	private input(nodeId: string): FieldInput {
		return {
			ctx: this.deps.ctx,
			config: this.deps.config,
			state: this.deps.state,
			nodeId,
			...(this.deps.hostname === undefined ? {} : { hostname: this.deps.hostname }),
			...(this.deps.arch === undefined ? {} : { arch: this.deps.arch })
		};
	}

	// #region lifecycle

	private queue<T>(work: () => Promise<T>): Promise<T> {
		const next = this.tail.then(work, work);
		this.tail = next.catch(() => undefined);
		return next;
	}

	/**
	 * Starts, stops or advances the link to match what is on disk.
	 *
	 * Safe to call every second: a call made while one is already queued joins it, and everything
	 * that touches the socket, frames included, runs on one chain so two passes never interleave.
	 * It does nothing while the link is backing off or has been stopped by the control plane.
	 */
	sync(): Promise<void> {
		if (this.pending) return this.tail as Promise<void>;
		this.pending = true;
		return this.queue(async () => {
			try {
				await this.pass();
			} finally {
				this.pending = false;
			}
		});
	}

	private async pass(): Promise<void> {
		const record = this.store.record();
		if (record === null) {
			if (this.phase !== 'idle') this.stop();
			return;
		}
		if (this.record !== null && this.record.nodeId !== record.nodeId) this.stop();
		this.record = record;
		if (this.phase === 'idle' && this.store.link().stopped === null) await this.dial();
		if (this.phase === 'ready') await this.report(false);
	}

	/** closes the socket and cancels every timer; the pairing on disk is untouched */
	stop(): void {
		this.closing = true;
		this.cancelRetry?.();
		this.cancelHandshake?.();
		this.cancelRetry = null;
		this.cancelHandshake = null;
		const socket = this.socket;
		this.socket = null;
		this.phase = 'idle';
		this.record = null;
		this.key = null;
		this.attempt = 0;
		if (socket !== null) {
			socket.onclose = null;
			socket.onmessage = null;
			socket.onerror = null;
			try {
				socket.close(1000, 'unpaired');
			} catch {
				// a socket that is already gone has nothing left to close
			}
		}
		this.closing = false;
	}

	private async dial(): Promise<void> {
		const record = this.record;
		if (record === null) return;
		this.phase = 'connecting';
		try {
			this.key = await new NodeKey(this.deps.secrets).load();
			if (this.key === null)
				throw new Error('the node key is missing from the secrets store');
			if (this.key.publicKey !== record.nodePublicKey) {
				throw new Error('the node key does not match the pairing record');
			}
			assertLink(record.linkUrl);
			await assertReachable(record.linkUrl, {
				...(this.deps.resolve === undefined ? {} : { resolve: this.deps.resolve })
			});
			const socket = this.connect(record.linkUrl);
			this.socket = socket;
			this.phase = 'handshake';
			socket.onmessage = (event) => this.enqueue(socket, event.data);
			socket.onclose = (event) => this.closed(socket, event.code, event.reason);
			socket.onerror = () => undefined;
			this.cancelHandshake = this.schedule(() => {
				if (this.phase === 'handshake' && this.socket === socket)
					socket.close(4408, 'no challenge');
			}, HANDSHAKE_WAIT_MS);
		} catch (error) {
			this.say(`cannot connect: ${error instanceof Error ? error.message : String(error)}`);
			this.retry(false);
		}
	}

	private retry(slow: boolean): void {
		this.phase = 'backoff';
		const wait = slow ? BACKOFF_CAP_MS : backoffMs(this.attempt, this.deps.random);
		this.attempt += 1;
		this.cancelRetry = this.schedule(() => {
			this.cancelRetry = null;
			if (this.phase === 'backoff') this.phase = 'idle';
			void this.sync();
		}, wait);
	}

	private closed(socket: Socket, code: number, reason: string): void {
		if (this.socket !== socket || this.closing) return;
		this.socket = null;
		this.cancelHandshake?.();
		this.cancelHandshake = null;
		const now = this.deps.ctx.now();
		this.store.patchLink({ connected: false, lastClose: { code, reason, at: now } });
		const action = closeAction(code);
		if (action === 'revoked' || action === 'unsupported_version') {
			this.phase = 'stopped';
			this.store.patchLink({ stopped: { reason: action, at: now } });
			this.say(
				action === 'revoked'
					? 'the control plane revoked this node, so the link has stopped; `bastion unpair` clears it'
					: 'the control plane does not speak a link version this bastion does, so the link has stopped; update bastion'
			);
			auditPair(this.deps.ctx, this.deps.state, this.deps.config.audit, {
				event: action === 'revoked' ? 'pair.revoked' : 'pair.stopped',
				principal: 'control-plane',
				level: 'warn',
				detail: { code, reason: action }
			});
			return;
		}
		this.say(`the link closed (${code}${reason === '' ? '' : ` ${reason}`}); retrying`);
		this.retry(action === 'wait');
	}

	// #endregion

	// #region frames

	private enqueue(socket: Socket, data: unknown): void {
		void this.queue(() => this.frame(socket, data)).catch((error) =>
			this.say(`a frame failed: ${error instanceof Error ? error.message : String(error)}`)
		);
	}

	private async frame(socket: Socket, data: unknown): Promise<void> {
		if (this.socket !== socket || this.record === null || this.key === null) return;
		if (typeof data !== 'string') return;
		let raw: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(data);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
			raw = parsed as Record<string, unknown>;
		} catch {
			return;
		}
		switch (raw.type) {
			case 'challenge':
				return this.answer(socket, raw);
			case 'ready':
				return this.ready(raw);
			case 'refused':
				this.say(`the control plane refused a message: ${String(raw.code).slice(0, 64)}`);
				this.store.patchLink({
					lastRefusal: { code: String(raw.code).slice(0, 64), at: this.deps.ctx.now() }
				});
				return;
			case 'command':
				return this.command(raw);
			case 'sites':
				return this.sites(raw);
			// a frame type a newer control plane added is ignored, which is what keeps minors additive
			default:
				return;
		}
	}

	private answer(socket: Socket, raw: Record<string, unknown>): void {
		const challenge = parseChallenge(raw);
		const record = this.record;
		if (challenge === null || record === null || this.key === null) return;
		const response = signChallengeResponse(
			{
				nodeId: record.nodeId,
				nonce: challenge.nonce,
				ts: this.deps.ctx.now(),
				range: {
					min: { major: FLEET_LINK_VERSION.major, minor: 0 },
					max: { major: FLEET_LINK_VERSION.major, minor: FLEET_LINK_VERSION.minor }
				}
			},
			this.key
		);
		socket.send(JSON.stringify(response));
	}

	private async ready(raw: Record<string, unknown>): Promise<void> {
		if (this.phase !== 'handshake') return;
		const lastSeq =
			typeof raw.lastSeq === 'number' && Number.isInteger(raw.lastSeq) ? raw.lastSeq : -1;
		this.cancelHandshake?.();
		this.cancelHandshake = null;
		this.floor = lastSeq;
		this.phase = 'ready';
		this.attempt = 0;
		const now = this.deps.ctx.now();
		this.store.patchLink({ connected: true, connectedAt: now, lastRefusal: null });
		this.lastFindings = '';
		this.lastAuditSeq = -1;
		await this.report(true);
	}

	private async command(raw: Record<string, unknown>): Promise<void> {
		const record = this.record;
		if (this.phase !== 'ready' || record === null) return;
		const now = this.deps.ctx.now();
		const verdict = verifyEnvelope(raw, {
			publicKey: record.dashboardPublicKey,
			direction: 'server',
			now,
			nodeId: record.nodeId
		});
		const audit = (code: string): void =>
			auditPair(this.deps.ctx, this.deps.state, this.deps.config.audit, {
				event: 'pair.command.refused',
				principal: 'control-plane',
				level: 'warn',
				detail: { code }
			});
		if (!verdict.ok) {
			audit(verdict.code);
			// the signature held, so an expired command is a real one and gets its answer
			if (verdict.code === 'command_expired') {
				await this.book.expire(raw as unknown as CommandEnvelope);
				await this.carry();
			}
			return;
		}
		const envelope = verdict.value as CommandEnvelope;
		const link = this.store.link();
		if (envelope.seq > link.ack) this.store.patchLink({ ack: envelope.seq });
		await this.book.receive(envelope);
		await this.carry();
	}

	/**
	 * Replaces the site id map with the one the control plane just sent.
	 *
	 * Checked like a command, and its `seq` has to rise above the highest one seen, so an older map
	 * captured earlier cannot replace a newer one. Anything refused leaves the map as it was.
	 */
	private async sites(raw: Record<string, unknown>): Promise<void> {
		const record = this.record;
		if (this.phase !== 'ready' || record === null) return;
		const verdict = verifyEnvelope(raw, {
			publicKey: record.dashboardPublicKey,
			direction: 'server',
			now: this.deps.ctx.now(),
			nodeId: record.nodeId
		});
		const refuse = (code: string): void =>
			auditPair(this.deps.ctx, this.deps.state, this.deps.config.audit, {
				event: 'pair.sites.refused',
				principal: 'control-plane',
				level: 'warn',
				detail: { code }
			});
		if (!verdict.ok) return refuse(verdict.code);
		const envelope = verdict.value as SitesEnvelope;
		const link = this.store.link();
		if (envelope.seq <= link.ack) return refuse('replayed');
		const siteIds: Record<string, string> = {};
		for (const entry of [...envelope.body.sites].sort((a, b) => (a.host < b.host ? -1 : 1))) {
			siteIds[entry.host.toLowerCase()] = entry.siteId;
		}
		const updated = this.store.replaceSiteIds(record.nodeId, siteIds);
		if (updated === null) return;
		this.record = updated;
		this.store.patchLink({ ack: envelope.seq });
		auditPair(this.deps.ctx, this.deps.state, this.deps.config.audit, {
			event: 'pair.sites',
			principal: 'control-plane',
			detail: { sites: envelope.body.sites.length }
		});
	}

	// #endregion

	// #region sending

	private send(type: NodeMessageType, body: unknown): boolean {
		const socket = this.socket;
		const record = this.record;
		if (this.phase !== 'ready' || socket === null || record === null || this.key === null) {
			return false;
		}
		const seq = this.store.nextSeq(this.floor);
		const message: Omit<Envelope, 'sig'> = {
			v: FLEET_LINK_VERSION.major,
			id: `msg_${randomUUID().replaceAll('-', '')}`,
			type,
			ts: this.deps.ctx.now(),
			seq,
			ack: this.store.link().ack,
			body
		};
		socket.send(JSON.stringify(signEnvelope(message, this.key)));
		const link = this.store.link();
		this.store.patchLink({
			lastMessageAt: message.ts,
			sentAt: { ...link.sentAt, [type]: message.ts }
		});
		return true;
	}

	/** sends the outcome of every command the control plane has not yet been told about */
	private async carry(): Promise<void> {
		for (const record of await this.book.sweep()) this.reply(record);
	}

	private reply(record: CommandRecord): void {
		const { body } = record.envelope;
		const result = record.result ?? { outcome: 'queued' as const, code: null, deploy: null };
		const sent = this.send(
			'command.result',
			commandResultBody(
				{ opId: body.opId, stepId: body.stepId, idempotencyKey: body.idempotencyKey },
				result
			)
		);
		if (sent) this.book.markReported(record.id);
	}

	/**
	 * The periodic reports, each only when it is due.
	 *
	 * Findings and the audit head are checked every minute and sent when they changed, with a
	 * heartbeat at the status interval so the control plane can tell a quiet box from a lost one.
	 */
	private async report(force: boolean): Promise<void> {
		const record = this.record;
		if (record === null) return;
		const now = this.deps.ctx.now();
		const sent = this.store.link().sentAt;
		const due = (type: string, every: number): boolean =>
			force || now - (sent[type] ?? 0) >= every;
		const input = this.input(record.nodeId);

		if (due('status', STATUS_EVERY_MS)) this.send('status', statusBody(input));

		if (due('findings', WATCH_EVERY_MS)) {
			const body = findingsBody(input);
			const text = JSON.stringify(body);
			if (
				force ||
				text !== this.lastFindings ||
				now - (sent.findings ?? 0) >= STATUS_EVERY_MS
			) {
				this.send('findings', body);
				this.lastFindings = text;
			} else {
				this.store.patchLink({ sentAt: { ...this.store.link().sentAt, findings: now } });
			}
		}

		if (due('audit.head', WATCH_EVERY_MS)) {
			const log = new AuditLog(
				this.deps.ctx,
				`${this.deps.state}/audit.ndjson`,
				this.deps.config.audit
			);
			if (
				force ||
				log.length !== this.lastAuditSeq ||
				now - (sent['audit.head'] ?? 0) >= STATUS_EVERY_MS
			) {
				this.send('audit.head', auditHeadBody(log));
				this.lastAuditSeq = log.length;
			} else {
				this.store.patchLink({
					sentAt: { ...this.store.link().sentAt, 'audit.head': now }
				});
			}
		}

		const analytics = this.deps.analytics;
		if (analytics !== undefined && !force) {
			if (now - (sent['metrics.batch'] ?? 0) >= METRICS_EVERY_MS) {
				const from = sent['metrics.batch'] ?? now - METRICS_EVERY_MS;
				this.send('metrics.batch', metricsBody(input, { from, to: now }, analytics));
			}
			if (now - (sent['usage.report'] ?? 0) >= USAGE_EVERY_MS) {
				const body = usageBody(
					{ nodeId: record.nodeId, now, siteIds: record.siteIds },
					analytics,
					sent['usage.report'] ?? now - USAGE_EVERY_MS
				);
				if (body === null) {
					this.store.patchLink({
						sentAt: { ...this.store.link().sentAt, 'usage.report': now }
					});
				} else this.send('usage.report', body);
			}
		}
		await this.carry();
	}

	// #endregion
}
