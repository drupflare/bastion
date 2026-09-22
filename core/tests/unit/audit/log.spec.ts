import { describe, expect, it } from 'vitest';
import {
	AuditLog,
	GENESIS,
	PROFILES,
	SEVERITY,
	buildSinks,
	ndjsonLine,
	shouldRecord,
	syslogLine,
	type AuditEvent
} from '../../../src/audit/log';
import { defaultConfig } from '../../../src/config/defaults';
import type { AuditConfig } from '../../../src/config/types';
import { defaultContext } from '../../../src/context';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';

function config(over: Partial<AuditConfig> = {}): AuditConfig {
	return { ...defaultConfig().audit, ...over };
}

function harness(over: Partial<AuditConfig> = {}) {
	const files = memoryFiles();
	const io = memoryIo();
	const ctx = { ...defaultContext(), files, io, env: {}, now: () => 1000 };
	return { ctx, files, io, log: new AuditLog(ctx, '/audit.ndjson', config(over)) };
}

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
	at: 1000,
	event: 'tenant.added',
	level: 'info',
	principal: 'operator',
	...over
});

describe('SEVERITY', () => {
	it('numbers debug below info and leaves the other four exactly as the worker defines them', () => {
		expect(SEVERITY).toEqual({ debug: -1, info: 0, warn: 1, error: 2, critical: 3 });
	});
});

describe('shouldRecord', () => {
	it('keeps per-request logging off under the default profile', () => {
		expect(shouldRecord(config(), 'request.served', 'debug')).toBe(false);
	});

	it('records it once an operator turns it on explicitly', () => {
		expect(
			shouldRecord(config({ events: { 'request.served': true } }), 'request.served', 'debug')
		).toBe(true);
	});

	it('honours an explicit off even at critical', () => {
		expect(
			shouldRecord(config({ events: { 'noisy.thing': false } }), 'noisy.thing', 'critical')
		).toBe(false);
	});

	it('records only security-relevant events under minimal', () => {
		const minimal = config({ profile: 'minimal', level: 'warn' });
		expect(shouldRecord(minimal, 'secret.read', 'info')).toBe(true);
		expect(shouldRecord(minimal, 'tenant.added', 'info')).toBe(false);
	});

	it('records everything under everything', () => {
		expect(shouldRecord(config({ profile: 'everything', level: 'debug' }), 'x', 'debug')).toBe(
			true
		);
	});

	it('names request.served as off in every profile that mentions it', () => {
		expect(PROFILES.minimal.events['request.served']).toBe(false);
		expect(PROFILES.balanced.events['request.served']).toBe(false);
	});
});

describe('AuditLog', () => {
	it('chains from a genesis hash', () => {
		const { log } = harness();
		expect(log.chainHead).toBe(GENESIS);
		const first = log.record(event());
		expect(first?.previous).toBe(GENESIS);
		expect(first?.seq).toBe(1);
	});

	it('links each line to the one before it', () => {
		const { log } = harness();
		const first = log.record(event());
		const second = log.record(event({ event: 'tenant.removed' }));
		expect(second?.previous).toBe(first?.hash);
	});

	it('verifies a chain it wrote', () => {
		const { log } = harness();
		log.record(event());
		log.record(event({ event: 'b' }));
		expect(log.verify()).toEqual({ ok: true, brokenAt: null, reason: '' });
	});

	it('finds a line that was edited after it was written', () => {
		const { log, files } = harness();
		log.record(event());
		log.record(event({ event: 'b' }));
		const lines = files
			.readText('/audit.ndjson')
			.split('\n')
			.filter((l) => l !== '');
		const tampered = JSON.parse(lines[0] as string) as Record<string, unknown>;
		tampered.principal = 'somebody-else';
		files.writeText('/audit.ndjson', [JSON.stringify(tampered), lines[1]].join('\n'));
		const result = log.verify();
		expect(result.ok).toBe(false);
		expect(result.brokenAt).toBe(1);
	});

	it('finds a line that was deleted', () => {
		const { log, files } = harness();
		log.record(event());
		log.record(event({ event: 'b' }));
		log.record(event({ event: 'c' }));
		const lines = files
			.readText('/audit.ndjson')
			.split('\n')
			.filter((l) => l !== '');
		files.writeText('/audit.ndjson', `${lines[0]}\n${lines[2]}\n`);
		expect(log.verify().ok).toBe(false);
	});

	it('resumes the chain when reopened, rather than restarting it', () => {
		const { ctx, log } = harness();
		const first = log.record(event());
		const reopened = new AuditLog(ctx, '/audit.ndjson', config());
		expect(reopened.chainHead).toBe(first?.hash);
		expect(reopened.record(event())?.seq).toBe(2);
	});

	it('carries the chain across a rotation, so rotating cannot reset it', () => {
		const { ctx, log, files } = harness();
		log.record(event());
		const head = log.chainHead;
		const rotated = log.rotate('1');
		expect(files.readText(rotated.rotatedTo)).toContain('tenant.added');
		const next = new AuditLog(ctx, '/audit.ndjson', config());
		expect(log.record(event())?.previous).toBe(head);
		expect(next.chainHead).toBe(GENESIS);
	});

	it('rotating an absent file is not an error', () => {
		expect(harness().log.rotate('1').rotatedTo).toBe('');
	});

	it('trims the oldest lines past the byte budget', () => {
		const { log } = harness();
		for (let i = 0; i < 20; i++) log.record(event({ event: `e${i}` }));
		const dropped = log.trim(500);
		expect(dropped).toBeGreaterThan(0);
		expect(log.read().length).toBeLessThan(20);
	});

	it('records nothing for an event the profile filters out', () => {
		const { log, files } = harness();
		expect(log.record(event({ event: 'request.served', level: 'debug' }))).toBe(null);
		expect(files.exists('/audit.ndjson')).toBe(false);
	});
});

describe('sinks', () => {
	it('maps bastion levels onto RFC 5424 severities rather than casting them', () => {
		const { log } = harness();
		const critical = log.record(event({ level: 'critical' }));
		expect(syslogLine(critical!)).toMatch(/^<82>1 /);
		const info = log.record(event({ level: 'info' }));
		expect(syslogLine(info!)).toMatch(/^<86>1 /);
	});

	it('writes NDJSON that parses back', () => {
		const { log } = harness();
		const recorded = log.record(event());
		expect(JSON.parse(ndjsonLine(recorded!)).event).toBe('tenant.added');
	});

	it('builds a file sink and a syslog sink', () => {
		const { ctx, files, io, log } = harness({ sinks: [{ type: 'file' }, { type: 'syslog' }] });
		const sinks = buildSinks(
			ctx,
			config({ sinks: [{ type: 'file' }, { type: 'syslog' }] }),
			'/logs'
		);
		const recorded = log.record(event());
		for (const sink of sinks) sink.write(recorded!);
		expect(files.readText('/logs/audit.ndjson')).toContain('tenant.added');
		expect(io.errText()).toContain('tenant.added');
	});

	it('refuses a sink type it does not know', () => {
		const { ctx } = harness();
		expect(() => buildSinks(ctx, config({ sinks: [{ type: 'kafka' }] }), '/logs')).toThrow(
			/unknown audit sink/
		);
	});
});
