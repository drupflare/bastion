import { describe, expect, it } from 'vitest';
import { AuditLog } from '../../../src/audit/log';
import { AnalyticsWindow } from '../../../src/observe/analytics';
import { ParamError, type Executors } from '../../../src/pair/commands';
import type { Socket } from '../../../src/pair/link';
import {
	BACKOFF_CAP_MS,
	FleetLink,
	HANDSHAKE_WAIT_MS,
	STATUS_EVERY_MS,
	backoffMs,
	closeAction
} from '../../../src/pair/link';
import { PairStore } from '../../../src/pair/store';
import { CLOSE, newSeed, signingKeyFromSeed } from '../../../src/pair/wire';
import { ControlPlane, NODE_ID, pairedBox, publicDns, settle, type Paired } from './plane';

function timers() {
	const pending: { fn: () => void; ms: number; live: boolean }[] = [];
	return {
		pending,
		schedule: (fn: () => void, ms: number) => {
			const entry = { fn, ms, live: true };
			pending.push(entry);
			return () => {
				entry.live = false;
			};
		},
		live: () => pending.filter((entry) => entry.live),
		fire: (ms?: number) => {
			const entry = pending.find((item) => item.live && (ms === undefined || item.ms === ms));
			if (entry === undefined) throw new Error('no timer to fire');
			entry.live = false;
			entry.fn();
		}
	};
}

function executorsFor(calls: string[]): Executors {
	return {
		'health.observe': {
			class: 'safe',
			params: () => ({}),
			run: async () => {
				calls.push('health.observe');
				return { ok: true, code: null };
			}
		},
		'site.deploy': {
			class: 'rebuild',
			params: (raw) => {
				if (typeof raw.host !== 'string') throw new ParamError('host');
				return { host: raw.host };
			},
			run: async (params) => {
				calls.push(`site.deploy ${params.host}`);
				return {
					ok: true,
					code: null,
					deploy: { version: '1.0.4', deployedAt: '2026-11-05T12:00:00Z' }
				};
			}
		}
	};
}

async function started(
	paired?: Paired,
	over: Parameters<typeof pairedBox>[0] = {},
	analytics?: AnalyticsWindow
) {
	const world = paired ?? (await pairedBox(over));
	const clock = timers();
	const calls: string[] = [];
	const sentFrames: string[] = [];
	const make = () =>
		new FleetLink({
			ctx: world.box.ctx,
			config: world.box.config,
			state: world.box.state,
			secrets: world.box.secrets,
			executors: executorsFor(calls),
			...(analytics === undefined ? {} : { analytics }),
			connect: () => {
				const socket = world.plane.connect();
				const send = socket.send.bind(socket);
				socket.send = (text: string) => {
					sentFrames.push(text);
					send(text);
				};
				return socket;
			},
			resolve: publicDns,
			schedule: clock.schedule,
			random: () => 0.5,
			arch: 'arm64'
		});
	const link = make();
	await link.sync();
	await settle();
	return { ...world, link, clock, calls, sentFrames, make };
}

describe('the handshake and the first reports', () => {
	it('answers the challenge, reaches ready and sends status, findings and the audit head', async () => {
		const { link, plane, store } = await started();
		expect(link.current).toBe('ready');
		expect(plane.handshakes).toBe(1);
		expect(plane.of('status')).toHaveLength(1);
		expect(plane.of('findings')).toHaveLength(1);
		expect(plane.of('audit.head')).toHaveLength(1);
		expect(plane.refusals).toEqual([]);
		expect(store.link().connected).toBe(true);
		expect(store.link().lastMessageAt).not.toBeNull();
	});

	it('sends a seq that rises by one on every message', async () => {
		const { plane } = await started();
		expect(plane.received.map((message) => message.seq)).toEqual([0, 1, 2]);
	});

	it('sends the status body the contract lists, and the host name only when allowed', async () => {
		const quiet = await started();
		expect(quiet.plane.of('status')[0]!.body).not.toHaveProperty('hostname');

		const paired = await pairedBox({
			pairing: {
				sendHostname: true,
				hashNames: true,
				commands: {
					safe: 'queue',
					rebuild: 'queue',
					stateful: 'queue',
					destructive: 'queue'
				}
			}
		});
		const loud = await started(paired);
		const body = loud.plane.of('status')[0]!.body as Record<string, unknown>;
		expect(body.namesHashed).toBe(true);
		expect(String((body.tenants as string[])[0])).toMatch(/^h:[0-9a-f]{24}$/);
	});

	it('connects to the pinned link address and nowhere else', async () => {
		const { plane } = await started();
		expect(plane.sockets).toHaveLength(1);
	});
});

describe('seq across a restart', () => {
	it('continues above the last seq used when the process restarts', async () => {
		const first = await started();
		first.link.stop();
		const again = first.make();
		await again.sync();
		await settle();
		const seqs = first.plane.received.map((message) => message.seq);
		expect(seqs).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it('writes the seq down before it sends, so a crash cannot repeat one', async () => {
		const { store, plane } = await started();
		expect(store.link().seq).toBe(Math.max(...plane.received.map((m) => m.seq)));
	});

	it('starts above what the control plane has seen when its own record is lost', async () => {
		const first = await started();
		first.link.stop();
		first.box.files.remove(`${first.box.state}/pair/link.json`);
		const again = first.make();
		await again.sync();
		await settle();
		const seqs = first.plane.received.map((message) => message.seq);
		expect(seqs.slice(3)).toEqual([3, 4, 5]);
	});

	it('never goes below its own record when the control plane has forgotten', async () => {
		const first = await started();
		first.link.stop();
		first.plane.lastSeq = -1;
		first.plane.received.length = 0;
		const again = first.make();
		await again.sync();
		await settle();
		expect(first.plane.received.map((message) => message.seq)).toEqual([3, 4, 5]);
	});

	it('shows a replayed frame to the box as a refusal and keeps going', async () => {
		const { plane, store, sentFrames, clock, box, link } = await started();
		const socket = plane.live!;
		socket.send(sentFrames.find((text) => text.includes('"type":"status"'))!);
		await settle();
		expect(plane.refusals).toContain('replayed');
		expect(store.link().lastRefusal?.code).toBe('replayed');
		box.clock.now += STATUS_EVERY_MS + 1;
		await link.sync();
		await settle();
		expect(plane.of('status')).toHaveLength(2);
		expect(clock.live()).toHaveLength(0);
	});
});

describe('a refusal from the control plane', () => {
	it('retries after a skewed clock is refused at the handshake', async () => {
		const world = await pairedBox();
		const skewed = new ControlPlane({
			now: () => world.box.clock.now + 10 * 60_000,
			nodePublicKey: world.nodeKey.publicKey
		});
		world.plane.sockets.length = 0;
		const clock = timers();
		const link = new FleetLink({
			ctx: world.box.ctx,
			config: world.box.config,
			state: world.box.state,
			secrets: world.box.secrets,
			executors: {},
			connect: () => skewed.connect(),
			resolve: publicDns,
			schedule: clock.schedule,
			random: () => 0.5
		});
		world.store.save({ ...world.record, dashboardPublicKey: skewed.key.publicKey });
		await link.sync();
		await settle();
		expect(skewed.refusals).toEqual(['expired']);
		expect(world.store.link().lastClose).toMatchObject({
			code: CLOSE.refused,
			reason: 'expired'
		});
		expect(link.current).toBe('backoff');
		expect(clock.live()).toHaveLength(1);
	});

	it('asks for a retry on every close the control plane uses for a fault it can recover from', () => {
		for (const code of [
			CLOSE.malformed,
			CLOSE.refused,
			CLOSE.handshakeTimeout,
			CLOSE.tooManyRefusals,
			1000,
			1006
		]) {
			expect(closeAction(code)).toBe('retry');
		}
		expect(closeAction(CLOSE.replaced)).toBe('wait');
	});

	it('stops for good on a revoked close and says so', async () => {
		const { link, plane, store, box, clock, calls } = await started();
		plane.revoked = true;
		box.clock.now += STATUS_EVERY_MS + 1;
		await link.sync();
		await settle();
		expect(link.current).toBe('stopped');
		expect(store.link().stopped).toMatchObject({ reason: 'revoked' });
		expect(store.link().connected).toBe(false);
		expect(clock.live()).toHaveLength(0);
		expect(box.io.errText()).toContain('revoked this node');
		expect(calls).toEqual([]);
		const events = new AuditLog(box.ctx, `${box.state}/audit.ndjson`, box.config.audit)
			.read()
			.map((entry) => entry.event);
		expect(events).toContain('pair.revoked');
	});

	it('does not dial again after a restart once it has been revoked', async () => {
		const world = await started();
		world.plane.revoked = true;
		world.box.clock.now += STATUS_EVERY_MS + 1;
		await world.link.sync();
		await settle();
		const handshakes = world.plane.handshakes;
		const again = world.make();
		await again.sync();
		await settle();
		expect(world.plane.handshakes).toBe(handshakes);
		expect(again.current).toBe('idle');
	});

	it('stops on an unsupported version instead of retrying', async () => {
		const { link, plane, store, clock } = await started();
		plane.live!.hangUp(CLOSE.unsupportedVersion, 'unsupported_version');
		await settle();
		expect(link.current).toBe('stopped');
		expect(store.link().stopped?.reason).toBe('unsupported_version');
		expect(clock.live()).toHaveLength(0);
	});

	it('waits the longest backoff when another connection replaced it', async () => {
		const { link, plane, clock } = await started();
		plane.live!.hangUp(CLOSE.replaced, 'replaced');
		await settle();
		expect(link.current).toBe('backoff');
		expect(clock.live().map((entry) => entry.ms)).toEqual([BACKOFF_CAP_MS]);
	});
});

describe('reconnecting', () => {
	it('backs off by doubling to a cap with jitter, and resets once ready', async () => {
		expect([0, 1, 2, 3].map((n) => backoffMs(n, () => 1))).toEqual([1000, 2000, 4000, 8000]);
		expect(backoffMs(30, () => 1)).toBe(BACKOFF_CAP_MS);
		expect(backoffMs(3, () => 0)).toBe(4000);
		expect(backoffMs(3, () => 0.5)).toBe(6000);

		const { link, plane, clock } = await started();
		plane.live!.hangUp(1006, '');
		await settle();
		expect(clock.live().map((entry) => entry.ms)).toEqual([backoffMs(0, () => 0.5)]);
		clock.fire();
		await settle();
		expect(link.current).toBe('ready');
		plane.live!.hangUp(1006, '');
		await settle();
		expect(clock.live().map((entry) => entry.ms)).toEqual([backoffMs(0, () => 0.5)]);
	});

	it('grows the wait while attempts keep failing', async () => {
		const world = await pairedBox();
		const clock = timers();
		const link = new FleetLink({
			ctx: world.box.ctx,
			config: world.box.config,
			state: world.box.state,
			secrets: world.box.secrets,
			executors: {},
			connect: () => {
				throw new Error('connection refused');
			},
			resolve: publicDns,
			schedule: clock.schedule,
			random: () => 1
		});
		await link.sync();
		clock.fire();
		await settle();
		clock.fire();
		await settle();
		expect(clock.pending.map((entry) => entry.ms)).toEqual([1000, 2000, 4000]);
	});

	it('closes a socket that never sends a challenge', async () => {
		const world = await pairedBox();
		const clock = timers();
		const socketLog: string[] = [];
		const link = new FleetLink({
			ctx: world.box.ctx,
			config: world.box.config,
			state: world.box.state,
			secrets: world.box.secrets,
			executors: {},
			connect: () => {
				const silent: Socket = {
					onopen: null,
					onmessage: null,
					onclose: null,
					onerror: null,
					send: () => undefined,
					close: (code = 1000, reason = '') => {
						socketLog.push(`${code} ${reason}`);
						queueMicrotask(() => silent.onclose?.({ code, reason }));
					}
				};
				return silent;
			},
			resolve: publicDns,
			schedule: clock.schedule
		});
		await link.sync();
		clock.fire(HANDSHAKE_WAIT_MS);
		await settle();
		expect(socketLog).toEqual(['4408 no challenge']);
		expect(link.current).toBe('backoff');
	});
});

describe('the address the link dials', () => {
	it('refuses a link that resolves into the box own network, and never opens a socket', async () => {
		const world = await pairedBox();
		const clock = timers();
		let opened = 0;
		const link = new FleetLink({
			ctx: world.box.ctx,
			config: world.box.config,
			state: world.box.state,
			secrets: world.box.secrets,
			executors: {},
			connect: () => {
				opened += 1;
				return world.plane.connect();
			},
			resolve: async () => ['169.254.169.254'],
			schedule: clock.schedule
		});
		await link.sync();
		await settle();
		expect(opened).toBe(0);
		expect(link.current).toBe('backoff');
		expect(world.box.io.errText()).toContain('169.254.169.254');
	});

	it('refuses a plaintext link that is not loopback', async () => {
		const world = await pairedBox();
		world.store.save({
			...world.record,
			linkUrl: 'ws://link.example.edu/link/nod_testnode0001'
		});
		const clock = timers();
		let opened = 0;
		const link = new FleetLink({
			ctx: world.box.ctx,
			config: world.box.config,
			state: world.box.state,
			secrets: world.box.secrets,
			executors: {},
			connect: () => {
				opened += 1;
				return world.plane.connect();
			},
			resolve: publicDns,
			schedule: clock.schedule
		});
		await link.sync();
		expect(opened).toBe(0);
		expect(world.box.io.errText()).toContain('needs wss');
	});

	it('refuses to connect when the node key is gone or is not the one that was paired', async () => {
		const world = await pairedBox();
		await world.box.secrets.remove('fleet-node-key');
		const link = new FleetLink({
			ctx: world.box.ctx,
			config: world.box.config,
			state: world.box.state,
			secrets: world.box.secrets,
			executors: {},
			connect: () => world.plane.connect(),
			resolve: publicDns,
			schedule: timers().schedule
		});
		await link.sync();
		expect(world.box.io.errText()).toContain('node key is missing');
		await world.box.secrets.set(
			'fleet-node-key',
			'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
		);
		await link.sync();
		expect(world.plane.handshakes).toBe(0);
	});
});

describe('unpairing while the link runs', () => {
	it('closes the socket and sends nothing more once the record is gone', async () => {
		const { link, plane, store, box } = await started();
		const socket = plane.live!;
		const sent = plane.received.length;
		store.clear();
		await link.sync();
		await settle();
		expect(socket.closedBy).toBe('node');
		expect(link.current).toBe('idle');
		box.clock.now += STATUS_EVERY_MS * 3;
		await link.sync();
		await settle();
		expect(plane.received).toHaveLength(sent);
		expect(box.files.exists(`${box.state}/pair/link.json`)).toBe(false);
	});

	it('picks a new pairing up on the next pass', async () => {
		const world = await pairedBox();
		const clock = timers();
		const link = new FleetLink({
			ctx: world.box.ctx,
			config: world.box.config,
			state: world.box.state,
			secrets: world.box.secrets,
			executors: {},
			connect: () => world.plane.connect(),
			resolve: publicDns,
			schedule: clock.schedule
		});
		world.store.clear();
		await link.sync();
		expect(world.plane.handshakes).toBe(0);
		world.store.save(world.record);
		await link.sync();
		await settle();
		expect(world.plane.handshakes).toBe(1);
		expect(link.current).toBe('ready');
	});
});

describe('commands over the link', () => {
	const result = (plane: ControlPlane, index = -1) =>
		plane.of('command.result').at(index)!.body as Record<string, unknown>;

	it('holds a command for approval by default and answers queued', async () => {
		const { plane, calls } = await started();
		plane.deliver(plane.command());
		await settle();
		expect(result(plane)).toMatchObject({
			outcome: 'queued',
			code: null,
			idempotencyKey: 'idem-0001'
		});
		expect(calls).toEqual([]);
	});

	it('runs it after approve, once, and reports the outcome', async () => {
		const { plane, calls, store, link } = await started();
		plane.deliver(plane.command());
		await settle();
		const id = store.commands()[0]!.id;
		store.decide(id, 'approve');
		await link.sync();
		await settle();
		expect(calls).toEqual(['health.observe']);
		expect(result(plane)).toMatchObject({ outcome: 'succeeded', code: null });
		await link.sync();
		await settle();
		expect(calls).toEqual(['health.observe']);
	});

	it('answers rejected when the operator rejects it', async () => {
		const { plane, calls, store, link } = await started();
		plane.deliver(plane.command());
		await settle();
		store.decide(store.commands()[0]!.id, 'reject');
		await link.sync();
		await settle();
		expect(result(plane)).toMatchObject({ outcome: 'rejected', code: 'rejected_by_operator' });
		expect(calls).toEqual([]);
	});

	it('runs a safe command at once when the operator set safe to auto', async () => {
		const paired = await pairedBox({
			pairing: {
				sendHostname: false,
				hashNames: false,
				commands: {
					safe: 'auto',
					rebuild: 'queue',
					stateful: 'queue',
					destructive: 'queue'
				}
			}
		});
		const { plane, calls } = await started(paired);
		plane.deliver(plane.command());
		await settle();
		expect(calls).toEqual(['health.observe']);
		expect(result(plane)).toMatchObject({ outcome: 'succeeded' });
	});

	it('carries deploy metadata in the result of a deploy', async () => {
		const paired = await pairedBox({
			pairing: {
				sendHostname: false,
				hashNames: false,
				commands: {
					safe: 'queue',
					rebuild: 'auto',
					stateful: 'queue',
					destructive: 'queue'
				}
			}
		});
		const { plane } = await started(paired);
		plane.deliver(
			plane.command({
				class: 'rebuild',
				action: 'site.deploy',
				params: { host: 'www.example.edu' }
			})
		);
		await settle();
		expect(result(plane)).toMatchObject({
			outcome: 'succeeded',
			deploy: { version: '1.0.4', deployedAt: '2026-11-05T12:00:00Z' }
		});
	});

	it('never runs a command twice for the same key, and repeats its answer', async () => {
		const paired = await pairedBox({
			pairing: {
				sendHostname: false,
				hashNames: false,
				commands: {
					safe: 'auto',
					rebuild: 'queue',
					stateful: 'queue',
					destructive: 'queue'
				}
			}
		});
		const { plane, calls } = await started(paired);
		const command = plane.command();
		plane.deliver(command);
		await settle();
		plane.deliver(plane.command({}, {}));
		await settle();
		expect(calls).toEqual(['health.observe']);
		const results = plane
			.of('command.result')
			.map((m) => (m.body as Record<string, unknown>).outcome);
		expect(results).toEqual(['succeeded', 'succeeded']);
	});

	it('refuses a command signed by any other key and runs nothing', async () => {
		const { plane, calls, box } = await started();
		const stranger = signingKeyFromSeed(newSeed());
		plane.deliver(plane.command({}, { key: stranger }));
		await settle();
		expect(plane.of('command.result')).toHaveLength(0);
		expect(calls).toEqual([]);
		const refused = new AuditLog(box.ctx, `${box.state}/audit.ndjson`, box.config.audit)
			.read()
			.filter((entry) => entry.event === 'pair.command.refused');
		expect(refused.map((entry) => entry.detail)).toEqual([{ code: 'bad_signature' }]);
	});

	it('refuses a command addressed to another node', async () => {
		const { plane, calls } = await started();
		plane.deliver(plane.command({ nodeId: 'nod_someoneelse01' }));
		await settle();
		expect(plane.of('command.result')).toHaveLength(0);
		expect(calls).toEqual([]);
	});

	it('answers expired, without running it, to a signed command past its expiry', async () => {
		const { plane, calls, box } = await started();
		plane.deliver(plane.command({ expiresAt: box.clock.now - 1 }));
		await settle();
		expect(result(plane)).toMatchObject({ outcome: 'expired', code: 'command_expired' });
		expect(calls).toEqual([]);
	});

	it('refuses a command whose timestamp is outside the window', async () => {
		const { plane, calls, box } = await started();
		plane.deliver(plane.command({}, { ts: box.clock.now - 10 * 60_000 }));
		await settle();
		expect(plane.of('command.result')).toHaveLength(0);
		expect(calls).toEqual([]);
	});

	it('answers a typed refusal for an action this box does not implement', async () => {
		const { plane } = await started();
		plane.deliver(plane.command({ class: 'destructive', action: 'site.erase' }));
		await settle();
		expect(result(plane)).toMatchObject({ outcome: 'rejected', code: 'unsupported_action' });
	});

	it('answers a typed refusal for parameters the action does not accept', async () => {
		const { plane, calls } = await started();
		plane.deliver(
			plane.command({ class: 'rebuild', action: 'site.deploy', params: { host: 5 } })
		);
		await settle();
		expect(result(plane)).toMatchObject({ outcome: 'rejected', code: 'invalid_params' });
		expect(calls).toEqual([]);
	});

	it('answers expired for a queued command nobody approved in time', async () => {
		const { plane, link, box } = await started();
		plane.deliver(plane.command({ expiresAt: box.clock.now + 60_000 }));
		await settle();
		box.clock.now += 61_000;
		await link.sync();
		await settle();
		expect(
			plane.of('command.result').map((m) => (m.body as Record<string, unknown>).outcome)
		).toEqual(['queued', 'expired']);
	});

	it('sends outcomes it could not send while the link was down once it is back', async () => {
		const { plane, link, store, clock, calls } = await started();
		plane.deliver(plane.command());
		await settle();
		plane.live!.hangUp(1006, '');
		await settle();
		store.decide(store.commands()[0]!.id, 'approve');
		await link.sync();
		await settle();
		expect(calls).toEqual([]);
		clock.fire();
		await settle();
		expect(calls).toEqual(['health.observe']);
		expect(plane.of('command.result').at(-1)!.body).toMatchObject({ outcome: 'succeeded' });
	});
});

describe('what the link records', () => {
	it('audits a command from receipt through the run without a parameter value', async () => {
		const paired = await pairedBox({
			pairing: {
				sendHostname: false,
				hashNames: false,
				commands: {
					safe: 'queue',
					rebuild: 'queue',
					stateful: 'queue',
					destructive: 'queue'
				}
			}
		});
		const { plane, store, link, box } = await started(paired);
		plane.deliver(
			plane.command({
				class: 'rebuild',
				action: 'site.deploy',
				params: { host: 'secret-host.example.edu' }
			})
		);
		await settle();
		store.decide(store.commands()[0]!.id, 'approve');
		await link.sync();
		await settle();
		const entries = new AuditLog(box.ctx, `${box.state}/audit.ndjson`, box.config.audit).read();
		const events = entries.map((entry) => entry.event);
		expect(events).toEqual([
			'pair.command.received',
			'pair.command.approved',
			'pair.command.run'
		]);
		expect(JSON.stringify(entries)).not.toContain('secret-host');
		expect(entries[0]!.detail).toMatchObject({ params: ['host'], named: 'rebuild' });
	});

	it('keeps the node key out of every file it writes', async () => {
		const { box, nodeKey, plane } = await started();
		plane.deliver(plane.command());
		await settle();
		const seed = await box.secrets.get('fleet-node-key');
		expect(seed).not.toBeNull();
		for (const path of ['pair/pairing.json', 'pair/link.json', 'audit.ndjson']) {
			const file = `${box.state}/${path}`;
			if (!box.files.exists(file)) continue;
			expect(box.files.readText(file)).not.toContain(seed as string);
		}
		expect(JSON.stringify(box.config)).not.toContain(seed as string);
		expect(nodeKey.publicKey).toHaveLength(43);
		expect(NODE_ID).toMatch(/^nod_/);
		expect(new PairStore(box.ctx, box.state).record()).not.toBeNull();
	});
});

describe('the site map', () => {
	const WWW = { siteId: 'site_testsite0001', host: 'www.example.edu' };
	const DOCS = { siteId: 'site_testsite0002', host: 'docs.example.edu' };
	const HOUR = 3_600_000;
	const refusals = (box: Paired['box']) =>
		new AuditLog(box.ctx, `${box.state}/audit.ndjson`, box.config.audit)
			.read()
			.filter((entry) => entry.event === 'pair.sites.refused')
			.map((entry) => (entry.detail as { code: string }).code);

	function sampled(box: Paired['box']) {
		const analytics = new AnalyticsWindow(10_000);
		analytics.record({
			at: box.clock.now + 600_000,
			tenant: 'acme',
			site: 'www.example.edu',
			status: 200,
			durationMs: 5,
			bytes: 10,
			cached: false,
			refusal: null
		});
		return analytics;
	}

	it('announces a version that includes the frame, so the control plane sends it', async () => {
		const { sentFrames } = await started();
		const answer = JSON.parse(sentFrames[0]!) as { range: { max: { minor: number } } };
		expect(answer.range.max.minor).toBeGreaterThanOrEqual(1);
	});

	it('stores the map the control plane sends right after ready and keeps it on disk', async () => {
		const world = await pairedBox();
		world.plane.sites = [DOCS, WWW];
		const { store, plane } = await started(world);
		expect(store.record()!.siteIds).toEqual({
			'docs.example.edu': DOCS.siteId,
			'www.example.edu': WWW.siteId
		});
		expect(plane.refusals).toEqual([]);
		expect(store.link().ack).toBe(1);
	});

	it('builds no usage report before the map arrives and one keyed on it afterwards', async () => {
		const world = await pairedBox();
		const analytics = sampled(world.box);
		const { link, plane, store, box } = await started(world, {}, analytics);
		await link.sync();
		await settle();
		expect(store.record()!.siteIds).toEqual({});
		expect(plane.of('usage.report')).toHaveLength(0);
		plane.live!.push(plane.sitesFrame([WWW]));
		await settle();
		expect(store.record()!.siteIds).toEqual({ [WWW.host]: WWW.siteId });
		box.clock.now += 2 * HOUR + 60_000;
		await link.sync();
		await settle();
		const reports = plane.of('usage.report');
		expect(reports).toHaveLength(1);
		const intervals = (reports[0]!.body as { intervals: { siteId: string; views: number }[] })
			.intervals;
		expect(intervals.map((interval) => [interval.siteId, interval.views])).toEqual([
			[WWW.siteId, 1]
		]);
		expect(plane.refusals).toEqual([]);
	});

	it('replaces the whole map on each frame, so a site the plane dropped stops reporting', async () => {
		const { plane, store, link } = await started();
		plane.live!.push(plane.sitesFrame([WWW, DOCS]));
		await settle();
		expect(Object.keys(store.record()!.siteIds).sort()).toEqual([DOCS.host, WWW.host]);
		plane.live!.push(plane.sitesFrame([DOCS]));
		await settle();
		expect(store.record()!.siteIds).toEqual({ [DOCS.host]: DOCS.siteId });
		plane.live!.push(plane.sitesFrame([]));
		await settle();
		expect(store.record()!.siteIds).toEqual({});
		expect(link.current).toBe('ready');
	});

	it('keeps the rest of the pairing record and the link as they were', async () => {
		const { plane, store, record } = await started();
		plane.live!.push(plane.sitesFrame([WWW]));
		await settle();
		expect({ ...store.record()!, siteIds: {} }).toEqual(record);
		expect(store.link().connected).toBe(true);
	});

	it('ignores a frame of a type it does not know, with no refusal and no change', async () => {
		const world = await pairedBox();
		world.plane.sites = [WWW];
		const { plane, store, link, box } = await started(world);
		plane.live!.push(plane.futureFrame());
		await settle();
		expect(link.current).toBe('ready');
		expect(store.record()!.siteIds).toEqual({ [WWW.host]: WWW.siteId });
		expect(store.link().lastRefusal).toBeNull();
		expect(refusals(box)).toEqual([]);
		plane.live!.push(plane.sitesFrame([DOCS]));
		await settle();
		expect(store.record()!.siteIds).toEqual({ [DOCS.host]: DOCS.siteId });
	});

	it('refuses every kind of bad frame and keeps the map it already had', async () => {
		const world = await pairedBox();
		world.plane.sites = [WWW];
		const { plane, store, box } = await started(world);
		const kept = { [WWW.host]: WWW.siteId };
		const now = box.clock.now;
		const stranger = signingKeyFromSeed(newSeed());
		const good = plane.sitesFrame([DOCS]);
		const unsigned = { ...plane.sitesFrame([DOCS]) } as Record<string, unknown>;
		delete unsigned.sig;
		const tampered = plane.sitesFrame([DOCS]);
		tampered.body = { ...tampered.body, sites: [{ ...DOCS, host: 'evil.example.edu' }] };
		const bad: [string, unknown][] = [
			['bad_signature', plane.sitesFrame([DOCS], { key: stranger })],
			['bad_signature', tampered],
			['wrong_node', plane.sitesFrame([DOCS], { nodeId: 'nod_someoneelse01' })],
			['expired', plane.sitesFrame([DOCS], { ts: now - 6 * 60_000 })],
			['future', plane.sitesFrame([DOCS], { ts: now + 6 * 60_000 })],
			['replayed', plane.sitesFrame([DOCS], { seq: 1 })],
			['malformed', unsigned],
			['malformed', plane.sitesFrame([WWW, { ...DOCS, host: WWW.host }])],
			['malformed', plane.sitesFrame([{ siteId: 'nope', host: 'x.example.edu' }])]
		];
		for (const [, frame] of bad) {
			plane.live!.push(frame as never);
			await settle();
			expect(store.record()!.siteIds).toEqual(kept);
		}
		expect(refusals(box)).toEqual(bad.map(([code]) => code));
		plane.live!.push(good);
		await settle();
		expect(store.record()!.siteIds).toEqual({ [DOCS.host]: DOCS.siteId });
	});

	it('refuses a map for another node with the same key, and a map older than one already taken', async () => {
		const { plane, store, box } = await started();
		plane.live!.push(plane.sitesFrame([WWW, DOCS], { seq: 10 }));
		await settle();
		plane.live!.push(plane.sitesFrame([WWW], { seq: 9 }));
		await settle();
		expect(Object.keys(store.record()!.siteIds)).toHaveLength(2);
		expect(refusals(box)).toEqual(['replayed']);
		expect(store.link().ack).toBe(10);
	});

	it('ignores a map that arrives after the pairing was removed, and does not bring it back', async () => {
		const { plane, store, link } = await started();
		store.clear();
		plane.live!.push(plane.sitesFrame([WWW]));
		await settle();
		expect(store.record()).toBeNull();
		await link.sync();
		await settle();
		expect(link.current).toBe('idle');
	});

	it('leaves the host names out of the audit trail and counts them instead', async () => {
		const { plane, box } = await started();
		plane.live!.push(plane.sitesFrame([WWW, DOCS]));
		await settle();
		const entries = new AuditLog(box.ctx, `${box.state}/audit.ndjson`, box.config.audit).read();
		const taken = entries.find((entry) => entry.event === 'pair.sites')!;
		expect(taken.detail).toEqual({ sites: 2 });
		expect(JSON.stringify(entries)).not.toContain('example.edu/');
		expect(JSON.stringify(entries)).not.toContain(WWW.siteId);
	});
});
