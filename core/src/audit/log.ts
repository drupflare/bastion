import { createHash } from 'node:crypto';
import type { AuditConfig, LogLevel } from '../config/types';
import type { Context } from '../context';
import { BastionError } from '../errors';

/** `debug` is -1 so the four values the worker's SEVERITY defines keep their numbers exactly */
export const SEVERITY: Record<LogLevel, number> = {
	debug: -1,
	info: 0,
	warn: 1,
	error: 2,
	critical: 3
};

export interface AuditEvent {
	at: number;
	event: string;
	level: LogLevel;
	/** who did it; every action records one */
	principal: string;
	tenant?: string;
	site?: string;
	detail?: Record<string, unknown>;
}

export interface ChainedEvent extends AuditEvent {
	seq: number;
	previous: string;
	hash: string;
}

/**
 * What each profile records.
 *
 * `request.served` is `debug` in every profile and therefore off unless someone turns it on. That
 * is measured rather than cautious: miniflare's observability wrote every request into one
 * unpruned file, reached 20.75 GB, and decayed the generator ceiling from 871 to 600 req/s with
 * nothing reporting it. At `info` it would be on under the default profile.
 */
export const PROFILES: Record<
	AuditConfig['profile'],
	{ minimum: LogLevel; events: Record<string, boolean> }
> = {
	minimal: {
		minimum: 'warn',
		events: {
			'secret.read': true,
			'secret.write': true,
			'auth.failed': true,
			'request.served': false
		}
	},
	balanced: {
		minimum: 'info',
		events: { 'secret.read': true, 'request.served': false }
	},
	everything: {
		minimum: 'debug',
		events: {}
	}
};

export function shouldRecord(config: AuditConfig, event: string, level: LogLevel): boolean {
	const profile = PROFILES[config.profile] ?? PROFILES.balanced;
	const explicit = config.events[event] ?? profile.events[event];
	if (explicit === false) return false;
	if (explicit === true) return true;
	const floor = SEVERITY[config.level] ?? SEVERITY[profile.minimum];
	return SEVERITY[level] >= floor;
}

export const GENESIS = '0'.repeat(64);

export function hashEvent(previous: string, event: AuditEvent, seq: number): string {
	const canonical = JSON.stringify({
		seq,
		at: event.at,
		event: event.event,
		level: event.level,
		principal: event.principal,
		tenant: event.tenant ?? null,
		site: event.site ?? null,
		detail: event.detail ?? null,
		previous
	});
	return createHash('sha256').update(canonical).digest('hex');
}

export function serialise(event: ChainedEvent): string {
	return JSON.stringify(event);
}

/**
 * An append-only, hash-chained audit log.
 *
 * Each line carries the hash of the one before it, so deleting or editing a line breaks every hash
 * after it and `audit verify` finds where. **The chain is carried ACROSS a rotation**: a rotated
 * file's last hash becomes the new file's `previous`, because a chain that restarts at every
 * rotation is a chain an attacker only has to rotate.
 *
 * Retention ships with the writer rather than after it, for the reason recorded in the profile
 * table above.
 */
export class AuditLog {
	private readonly ctx: Context;
	private readonly path: string;
	private readonly config: AuditConfig;
	private seq = 0;
	private head = GENESIS;

	constructor(ctx: Context, path: string, config: AuditConfig) {
		this.ctx = ctx;
		this.path = path;
		this.config = config;
		const existing = this.read();
		const last = existing[existing.length - 1];
		if (last !== undefined) {
			this.seq = last.seq;
			this.head = last.hash;
		}
	}

	get chainHead(): string {
		return this.head;
	}

	get length(): number {
		return this.seq;
	}

	read(): ChainedEvent[] {
		if (!this.ctx.files.exists(this.path)) return [];
		return this.ctx.files
			.readText(this.path)
			.split('\n')
			.filter((line) => line.trim() !== '')
			.map((line) => JSON.parse(line) as ChainedEvent);
	}

	record(event: AuditEvent): ChainedEvent | null {
		if (!shouldRecord(this.config, event.event, event.level)) return null;
		const seq = this.seq + 1;
		const hash = hashEvent(this.head, event, seq);
		const chained: ChainedEvent = { ...event, seq, previous: this.head, hash };
		const existing = this.ctx.files.exists(this.path) ? this.ctx.files.readText(this.path) : '';
		this.ctx.files.writeText(this.path, `${existing}${serialise(chained)}\n`);
		this.seq = seq;
		this.head = hash;
		return chained;
	}

	/** walks the chain and names the first line that does not follow from the one before it */
	verify(): { ok: boolean; brokenAt: number | null; reason: string } {
		let previous = GENESIS;
		for (const event of this.read()) {
			const expected = hashEvent(previous, event, event.seq);
			if (event.previous !== previous) {
				return {
					ok: false,
					brokenAt: event.seq,
					reason: 'the previous hash does not match'
				};
			}
			if (event.hash !== expected) {
				return {
					ok: false,
					brokenAt: event.seq,
					reason: 'the line was changed after it was written'
				};
			}
			previous = event.hash;
		}
		return { ok: true, brokenAt: null, reason: '' };
	}

	/**
	 * Rotates the file, carrying the chain across.
	 *
	 * The rotated file keeps its own lines; the live file starts empty with `previous` still
	 * pointing at the rotated head, so `audit verify --all` walks both in order.
	 */
	rotate(suffix: string): { rotatedTo: string; head: string } {
		if (!this.ctx.files.exists(this.path)) return { rotatedTo: '', head: this.head };
		const target = `${this.path}.${suffix}`;
		this.ctx.files.writeText(target, this.ctx.files.readText(this.path));
		this.ctx.files.writeText(this.path, '');
		return { rotatedTo: target, head: this.head };
	}

	/** drops the oldest lines once the file is over its byte budget */
	trim(maxBytes: number): number {
		if (!this.ctx.files.exists(this.path)) return 0;
		const lines = this.ctx.files
			.readText(this.path)
			.split('\n')
			.filter((line) => line !== '');
		let total = lines.reduce((n, line) => n + line.length + 1, 0);
		let dropped = 0;
		while (total > maxBytes && lines.length > 0) {
			const line = lines.shift() as string;
			total -= line.length + 1;
			dropped++;
		}
		this.ctx.files.writeText(this.path, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
		return dropped;
	}
}

export interface Sink {
	type: string;
	write(event: ChainedEvent): void;
}

/** RFC 5424 severity, which is not bastion's ladder and has to be mapped rather than cast */
const SYSLOG_SEVERITY: Record<LogLevel, number> = {
	debug: 7,
	info: 6,
	warn: 4,
	error: 3,
	critical: 2
};

export function syslogLine(event: ChainedEvent, facility = 10): string {
	const priority = facility * 8 + SYSLOG_SEVERITY[event.level];
	const at = new Date(event.at).toISOString();
	return `<${priority}>1 ${at} bastion ${event.event} ${event.seq} - ${JSON.stringify(event.detail ?? {})}`;
}

export function ndjsonLine(event: ChainedEvent): string {
	return JSON.stringify(event);
}

export function buildSinks(ctx: Context, config: AuditConfig, root: string): Sink[] {
	return config.sinks.map((sink) => {
		if (sink.type === 'file') {
			return {
				type: 'file',
				write: (event) => {
					const path = `${root}/audit.ndjson`;
					const existing = ctx.files.exists(path) ? ctx.files.readText(path) : '';
					ctx.files.writeText(path, `${existing}${ndjsonLine(event)}\n`);
				}
			};
		}
		if (sink.type === 'syslog') {
			return {
				type: 'syslog',
				write: (event) => {
					ctx.io.err(syslogLine(event));
				}
			};
		}
		throw new BastionError('config-invalid', `unknown audit sink ${sink.type}`);
	});
}
