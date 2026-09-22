import { SEVERITY } from '../audit/log';
import type { LogLevel, LogsConfig, RetentionConfig } from '../config/types';
import type { Context } from '../context';

export interface LogLine {
	at: number;
	level: LogLevel;
	message: string;
	tenant?: string;
	site?: string;
	fields?: Record<string, unknown>;
}

export function formatLine(line: LogLine): string {
	return JSON.stringify({
		at: new Date(line.at).toISOString(),
		level: line.level,
		message: line.message,
		...(line.tenant === undefined ? {} : { tenant: line.tenant }),
		...(line.site === undefined ? {} : { site: line.site }),
		...(line.fields ?? {})
	});
}

export function parseAge(age: string | undefined): number | null {
	if (age === undefined) return null;
	const match = /^(\d+)([hdwm])$/.exec(age.trim());
	if (match === null) return null;
	const count = Number(match[1]);
	const unit = match[2];
	const hour = 3_600_000;
	if (unit === 'h') return count * hour;
	if (unit === 'd') return count * 24 * hour;
	if (unit === 'w') return count * 7 * 24 * hour;
	return count * 30 * 24 * hour;
}

/**
 * Structured logs on disk, with retention attached.
 *
 * Per-request logging is `debug` and therefore off by default, and `debugRetention` is deliberately
 * tighter than the ordinary one: it is the single most valuable thing to have while diagnosing and
 * the fastest way to fill a disk, and this project has already paid 20.75 GB to learn that.
 */
export class LogWriter {
	private readonly ctx: Context;
	private readonly root: string;
	private readonly config: LogsConfig;

	constructor(ctx: Context, root: string, config: LogsConfig) {
		this.ctx = ctx;
		this.root = root;
		this.config = config;
	}

	private pathFor(level: LogLevel): string {
		return level === 'debug' ? `${this.root}/debug.ndjson` : `${this.root}/bastion.ndjson`;
	}

	enabled(level: LogLevel): boolean {
		return SEVERITY[level] >= SEVERITY[this.config.level];
	}

	write(line: LogLine): boolean {
		if (!this.enabled(line.level)) return false;
		const path = this.pathFor(line.level);
		const existing = this.ctx.files.exists(path) ? this.ctx.files.readText(path) : '';
		this.ctx.files.writeText(path, `${existing}${formatLine(line)}\n`);
		return true;
	}

	read(level: LogLevel = 'info', limit = 100): LogLine[] {
		const path = this.pathFor(level);
		if (!this.ctx.files.exists(path)) return [];
		const lines = this.ctx.files
			.readText(path)
			.split('\n')
			.filter((line) => line.trim() !== '');
		return lines.slice(-limit).map((line) => {
			const parsed = JSON.parse(line) as { at: string } & Omit<LogLine, 'at'>;
			return { ...parsed, at: Date.parse(parsed.at) };
		});
	}

	/** applies both halves of a retention policy: the age first, then the byte budget */
	prune(level: LogLevel, now: number): { dropped: number } {
		const retention: RetentionConfig =
			level === 'debug' ? this.config.debugRetention : this.config.retention;
		const path = this.pathFor(level);
		if (!this.ctx.files.exists(path)) return { dropped: 0 };
		let lines = this.ctx.files
			.readText(path)
			.split('\n')
			.filter((line) => line.trim() !== '');
		const before = lines.length;

		const maxAge = parseAge(retention.maxAge);
		if (maxAge !== null) {
			lines = lines.filter((line) => {
				const at = Date.parse((JSON.parse(line) as { at: string }).at);
				return now - at <= maxAge;
			});
		}
		if (retention.maxBytes !== undefined) {
			let total = lines.reduce((n, line) => n + line.length + 1, 0);
			while (total > retention.maxBytes && lines.length > 0) {
				total -= (lines.shift() as string).length + 1;
			}
		}
		this.ctx.files.writeText(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
		return { dropped: before - lines.length };
	}
}
