import { randomUUID } from 'node:crypto';
import { defaultConfig } from '../../../src/config/defaults';
import type { BastionConfig } from '../../../src/config/types';
import { defaultContext, type Context } from '../../../src/context';
import { scriptedRunner } from '../../../src/host/exec';
import { memoryFiles, type FileHost } from '../../../src/host/files';
import { memoryIo, type MemoryIo } from '../../../src/io';
import type { Socket } from '../../../src/pair/link';
import { PairStore, type PairingRecord } from '../../../src/pair/store';
import {
	CLOSE,
	FLEET_LINK_VERSION,
	newChallenge,
	newSeed,
	signEnvelope,
	signingKeyFromSeed,
	verifyChallengeResponse,
	verifyEnvelope,
	type Challenge,
	type CommandBody,
	type Envelope,
	type SigningKey,
	type SitesBody
} from '../../../src/pair/wire';
import { fileSecrets, type SecretStore } from '../../../src/secrets/store';

export const STATE = '/var/lib/bastion';
export const NODE_ID = 'nod_testnode0001';

export interface Box {
	ctx: Context;
	io: MemoryIo;
	files: FileHost;
	secrets: SecretStore;
	config: BastionConfig;
	clock: { now: number };
	state: string;
}

/** a box with in-memory files, an encrypted secrets file, and a clock a spec moves by hand */
export function newBox(over: Partial<BastionConfig> = {}, start = 1_790_000_000_000): Box {
	const files = memoryFiles();
	const io = memoryIo();
	const clock = { now: start };
	const ctx: Context = {
		...defaultContext(),
		files,
		io,
		runner: scriptedRunner(),
		fetch: () => Promise.reject(new Error('the gate lane reaches no network')),
		env: {},
		cwd: '/srv',
		platform: 'linux',
		now: () => clock.now
	};
	const config: BastionConfig = {
		...defaultConfig(),
		state: STATE,
		tenants: [
			{ name: 'acme', sites: [{ host: 'www.example.edu', bundle: './b.tgz' }] },
			{ name: 'beta', sites: [{ host: 'docs.example.edu', bundle: './b.tgz' }] }
		],
		...over
	};
	return {
		ctx,
		io,
		files,
		clock,
		config,
		state: STATE,
		secrets: fileSecrets(ctx, `${STATE}/secrets/secrets.age`, 'a test passphrase')
	};
}

// #region the control plane

type Frame = Record<string, unknown>;

class PlaneSocket implements Socket {
	onopen: Socket['onopen'] = null;
	onmessage: Socket['onmessage'] = null;
	onclose: Socket['onclose'] = null;
	onerror: Socket['onerror'] = null;
	closedBy: 'node' | 'plane' | null = null;
	state:
		| { phase: 'challenge'; challenge: Challenge; refused: number }
		| { phase: 'ready'; refused: number };

	constructor(
		private readonly plane: ControlPlane,
		challenge: Challenge
	) {
		this.state = { phase: 'challenge', challenge, refused: 0 };
	}

	send(text: string): void {
		const copy = text;
		queueMicrotask(() => void this.plane.receive(this, copy));
	}

	close(code = 1000, reason = ''): void {
		if (this.closedBy !== null) return;
		this.closedBy = 'node';
		queueMicrotask(() => this.onclose?.({ code, reason }));
	}

	/** what the plane does: a frame to the node, or a close the node sees */
	push(frame: Frame | Envelope): void {
		const text = JSON.stringify(frame);
		queueMicrotask(() => this.onmessage?.({ data: text }));
	}

	hangUp(code: number, reason: string): void {
		if (this.closedBy !== null) return;
		this.closedBy = 'plane';
		queueMicrotask(() => this.onclose?.({ code, reason }));
	}
}

export interface PlaneOptions {
	now: () => number;
	nodeId?: string;
	nodePublicKey: string;
	/** the highest `seq` the plane says it has already seen, as `ready` reports it */
	lastSeq?: number;
}

/**
 * An in-process control plane that speaks the link's frames.
 *
 * Written from `engine/src/node-link.ts` in the dashboard repo, not from memory: a challenge frame
 * on open, the node's bare signed answer, `ready` with `version` and `lastSeq`, `refused` frames
 * with the five-refusal close, the private-use close codes, strictly rising `seq`, and commands as
 * bare signed envelopes. It signs with a key of its own and verifies the node against the key it
 * was told at claim, so a pinned-key mistake on the box shows up here.
 */
export class ControlPlane {
	readonly key: SigningKey;
	readonly nodeId: string;
	readonly received: Envelope[] = [];
	readonly refusals: string[] = [];
	readonly sockets: PlaneSocket[] = [];
	lastSeq: number;
	outSeq = 0;
	revoked = false;
	handshakes = 0;
	/** how a spec makes the plane skip a step */
	hold: { ready?: boolean } = {};
	/** when set, every connection is sent this map right after `ready`, as the engine does */
	sites: SitesBody['sites'] | null = null;

	constructor(private readonly options: PlaneOptions) {
		this.key = signingKeyFromSeed(newSeed());
		this.nodeId = options.nodeId ?? NODE_ID;
		this.lastSeq = options.lastSeq ?? -1;
	}

	/** what the box's `connect` returns for the link address */
	connect = (): Socket => {
		const socket = new PlaneSocket(this, newChallenge(this.options.now()));
		this.sockets.push(socket);
		queueMicrotask(() => {
			socket.onopen?.({});
			socket.push({
				type: 'challenge',
				...(socket.state as { challenge: Challenge }).challenge
			});
		});
		return socket;
	};

	get live(): PlaneSocket | null {
		return (
			[...this.sockets]
				.reverse()
				.find((s) => s.closedBy === null && s.state.phase === 'ready') ?? null
		);
	}

	private refuse(
		socket: PlaneSocket,
		code: string,
		close?: { code: number; reason: string }
	): void {
		this.refusals.push(code);
		socket.push({ type: 'refused', code });
		if (close) {
			socket.hangUp(close.code, close.reason);
			return;
		}
		socket.state.refused += 1;
		if (socket.state.refused > 5)
			socket.hangUp(CLOSE.tooManyRefusals, 'too many refused messages');
	}

	async receive(socket: PlaneSocket, text: string): Promise<void> {
		let raw: unknown;
		try {
			raw = JSON.parse(text);
		} catch {
			this.refuse(socket, 'malformed');
			return;
		}
		const now = this.options.now();
		if (socket.state.phase === 'challenge') {
			this.handshakes += 1;
			if (this.revoked) {
				this.refuse(socket, 'node_revoked', {
					code: CLOSE.revoked,
					reason: 'node_revoked'
				});
				return;
			}
			const verdict = verifyChallengeResponse(raw, {
				publicKey: this.options.nodePublicKey,
				nonce: socket.state.challenge.nonce,
				now
			});
			if (!verdict.ok) {
				const code =
					verdict.code === 'unsupported_version'
						? CLOSE.unsupportedVersion
						: CLOSE.refused;
				this.refuse(socket, verdict.code, { code, reason: verdict.code });
				return;
			}
			if (verdict.value.nodeId !== this.nodeId) {
				this.refuse(socket, 'wrong_node', { code: CLOSE.refused, reason: 'wrong_node' });
				return;
			}
			const { min, max } = verdict.value.range;
			if (min.major > FLEET_LINK_VERSION.major || max.major < FLEET_LINK_VERSION.major) {
				this.refuse(socket, 'unsupported_version', {
					code: CLOSE.unsupportedVersion,
					reason: 'unsupported_version'
				});
				return;
			}
			socket.state = { phase: 'ready', refused: 0 };
			if (this.hold.ready) return;
			socket.push({
				type: 'ready',
				version: { major: FLEET_LINK_VERSION.major, minor: FLEET_LINK_VERSION.minor },
				lastSeq: this.lastSeq
			});
			if (this.sites !== null) socket.push(this.sitesFrame(this.sites));
			return;
		}
		if (this.revoked) {
			this.refuse(socket, 'node_revoked', { code: CLOSE.revoked, reason: 'node_revoked' });
			return;
		}
		const verdict = verifyEnvelope(raw, {
			publicKey: this.options.nodePublicKey,
			direction: 'node',
			now
		});
		if (!verdict.ok) {
			this.refuse(socket, verdict.code);
			return;
		}
		const message = verdict.value;
		if (message.seq <= this.lastSeq) {
			this.refuse(socket, 'replayed');
			return;
		}
		this.lastSeq = message.seq;
		socket.state.refused = 0;
		this.received.push(message);
	}

	of(type: string): Envelope[] {
		return this.received.filter((message) => message.type === type);
	}

	/** a signed command the way `buildCommand` and `signCommand` make one */
	command(
		over: Partial<CommandBody> = {},
		options: { ts?: number; key?: SigningKey; id?: string } = {}
	): Envelope<CommandBody> {
		const now = options.ts ?? this.options.now();
		const body: CommandBody = {
			nodeId: this.nodeId,
			opId: 'op_testop000001',
			stepId: 'step-1',
			idempotencyKey: 'idem-0001',
			expiresAt: now + 15 * 60_000,
			class: 'safe',
			approval: 'local',
			action: 'health.observe',
			params: {},
			...over
		};
		return signEnvelope<CommandBody>(
			{
				v: FLEET_LINK_VERSION.major,
				id: options.id ?? `msg_${randomUUID().replaceAll('-', '')}`,
				type: 'command',
				ts: now,
				seq: ++this.outSeq,
				ack: Math.max(0, this.lastSeq),
				body
			},
			options.key ?? this.key
		);
	}

	deliver(command: Envelope<CommandBody>): void {
		this.live?.push(command);
	}

	/** a signed site map the way `buildSites` and `signSites` make one */
	sitesFrame(
		sites: SitesBody['sites'],
		options: { ts?: number; key?: SigningKey; id?: string; seq?: number; nodeId?: string } = {}
	): Envelope<SitesBody> {
		return signEnvelope<SitesBody>(
			{
				v: FLEET_LINK_VERSION.major,
				id: options.id ?? `msg_${randomUUID().replaceAll('-', '')}`,
				type: 'sites',
				ts: options.ts ?? this.options.now(),
				seq: options.seq ?? ++this.outSeq,
				ack: Math.max(0, this.lastSeq),
				body: { nodeId: options.nodeId ?? this.nodeId, sites }
			},
			options.key ?? this.key
		);
	}

	/** a correctly signed frame of a type this box does not know, as a newer minor might send */
	futureFrame(type = 'sites.v2'): Envelope {
		return signEnvelope(
			{
				v: FLEET_LINK_VERSION.major,
				id: `msg_${randomUUID().replaceAll('-', '')}`,
				type,
				ts: this.options.now(),
				seq: ++this.outSeq,
				ack: Math.max(0, this.lastSeq),
				body: { anything: [1, 2, 3] }
			},
			this.key
		);
	}
}

// #endregion

/** lets queued microtasks and the link's own promise chain run to a standstill */
export async function settle(rounds = 12): Promise<void> {
	for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

export interface Paired {
	box: Box;
	plane: ControlPlane;
	store: PairStore;
	record: PairingRecord;
	nodeKey: SigningKey;
}

/** a box that already holds a pairing record, a node key, and a plane that knows both */
export async function pairedBox(over: Partial<BastionConfig> = {}): Promise<Paired> {
	const box = newBox(over);
	const { NodeKey } = await import('../../../src/pair/store');
	const nodeKey = await new NodeKey(box.secrets).create();
	const plane = new ControlPlane({ now: () => box.clock.now, nodePublicKey: nodeKey.publicKey });
	const store = new PairStore(box.ctx, box.state);
	const record: PairingRecord = {
		nodeId: NODE_ID,
		linkUrl: 'wss://link.example.edu/link/nod_testnode0001',
		dashboardPublicKey: plane.key.publicKey,
		nodePublicKey: nodeKey.publicKey,
		pairedAt: box.clock.now,
		siteIds: {}
	};
	store.save(record);
	return { box, plane, store, record, nodeKey };
}

/** a hostname resolver that answers a public address, so the egress check passes without DNS */
export const publicDns = async (): Promise<string[]> => ['203.0.113.10'];
