import type { LogLevel } from '../config/types';
import type { Context } from '../context';
import {
	newLadderState,
	nextRung,
	recordFailure,
	recordRecovery,
	type LadderState,
	type Rung
} from './ladder';
import { BY_CODE, type Finding } from './tripwires';

export interface LedgerEntry {
	finding: Finding;
	/** what an automatic pass did about it, or null where it only recorded */
	rung: Rung | null;
	reason: string;
	/** how to put it back, so every automatic repair is undoable */
	undo: string | null;
	at: number;
}

export interface HealthNode {
	name: string;
	severity: LogLevel;
	detail: string;
	children: HealthNode[];
}

const WORST: LogLevel[] = ['debug', 'info', 'warn', 'error', 'critical'];

function worse(a: LogLevel, b: LogLevel): LogLevel {
	return WORST.indexOf(a) >= WORST.indexOf(b) ? a : b;
}

/** where a ledger keeps its findings, under the state directory the operator configured */
export const LEDGER_FILE = 'health/findings.jsonl';

/** a recovery is a line too, so replaying the file reconstructs the ladder rather than guessing */
interface RecoveryLine {
	kind: 'recovered';
	scope: string;
	code: string;
	at: number;
}

type Line = (LedgerEntry & { kind?: 'found' }) | RecoveryLine;

/**
 * What was found, what was done about it, and how to undo it.
 *
 * The `undo` column is the part that matters more than the automation. Break-glass is the
 * requirement: every automatic repair records what it did, is reversible, and `bastion diagnose`
 * explains it. A repair nobody can reverse is a repair nobody should have run.
 *
 * **Findings live in a file, because the process that finds them is not the process that reports
 * them.** `serve` detects; `bastion health` and `bastion diagnose` run later, from a different
 * process, often after a restart. Held in memory this was a ledger created empty by each CLI
 * invocation, read, and thrown away: every one of the 33 tripwires was unreachable by construction
 * and nothing ever called `record`.
 *
 * A file rather than the management API for the reason the plan already gives for logs: a
 * partitioned node has to stay diagnosable from itself, so reading its own health must need no
 * credential and no network. Append-only and replayed on load, which is also what reconstructs the
 * strike counts and quarantine timestamps a crash would otherwise lose.
 */
export class HealthLedger {
	private readonly ctx: Context;
	private readonly entries: LedgerEntry[] = [];
	private readonly states = new Map<string, LadderState>();
	private degraded = false;
	/** absent for a ledger nobody persists, which is what a pure decision test wants */
	private readonly path: string | null;

	constructor(ctx: Context, state?: string) {
		this.ctx = ctx;
		this.path = state === undefined ? null : `${state}/${LEDGER_FILE}`;
		this.replay();
	}

	/**
	 * Rebuilds the entries and the ladder from the file.
	 *
	 * A malformed line is skipped rather than fatal: a ledger that refuses to load because one
	 * write was torn by a power cut is a box that cannot report its own health at the moment that
	 * matters most.
	 */
	private replay(): void {
		if (this.path === null || !this.ctx.files.exists(this.path)) return;
		for (const raw of this.ctx.files.readText(this.path).split('\n')) {
			if (raw.trim() === '') continue;
			let line: Line;
			try {
				line = JSON.parse(raw) as Line;
			} catch {
				continue;
			}
			if ('kind' in line && line.kind === 'recovered') {
				const key = `${line.scope}/${line.code}`;
				this.states.set(key, recordRecovery(this.state(line.scope, line.code)));
				continue;
			}
			const entry = line as LedgerEntry;
			if (entry.finding === undefined) continue;
			this.entries.push(entry);
			const key = `${entry.finding.scope}/${entry.finding.code}`;
			const next = recordFailure(
				this.state(entry.finding.scope, entry.finding.code),
				entry.finding.at
			);
			if (entry.rung === 'quarantine') next.quarantinedAt = entry.at;
			this.states.set(key, next);
		}
	}

	private append(line: Line): void {
		if (this.path === null) return;
		this.ctx.files.mkdirp(this.path.slice(0, this.path.lastIndexOf('/')));
		this.ctx.files.appendText(this.path, `${JSON.stringify(line)}\n`);
	}

	/**
	 * Drops the oldest lines once the file passes a ceiling.
	 *
	 * The same rule the audit and runtime logs carry, for the same measured reason: an append-only
	 * file with no bound is how miniflare's observability reached 20.75 GB and decayed the
	 * generator ceiling with nothing reporting it.
	 */
	trim(maxBytes: number): number {
		if (this.path === null || !this.ctx.files.exists(this.path)) return 0;
		const lines = this.ctx.files.readText(this.path).split('\n').filter(Boolean);
		let kept = lines;
		let dropped = 0;
		while (kept.join('\n').length + 1 > maxBytes && kept.length > 0) {
			kept = kept.slice(1);
			dropped += 1;
		}
		this.ctx.files.writeText(this.path, kept.length === 0 ? '' : `${kept.join('\n')}\n`);
		return dropped;
	}

	get all(): LedgerEntry[] {
		return [...this.entries];
	}

	setDegraded(value: boolean): void {
		this.degraded = value;
		for (const [key, state] of this.states) this.states.set(key, { ...state, degraded: value });
	}

	state(scope: string, code: string): LadderState {
		const key = `${scope}/${code}`;
		return this.states.get(key) ?? { ...newLadderState(), degraded: this.degraded };
	}

	/** records a finding and decides what an automatic pass would do about it */
	record(found: Finding, options: { auto?: boolean; undo?: string | null } = {}): LedgerEntry {
		const key = `${found.scope}/${found.code}`;
		const state = recordFailure(this.state(found.scope, found.code), found.at);
		const decision = nextRung(found.severity, state, this.ctx.now(), options);
		if (decision.rung === 'quarantine') state.quarantinedAt = this.ctx.now();
		this.states.set(key, state);
		const entry: LedgerEntry = {
			finding: found,
			rung: decision.rung,
			reason: decision.reason,
			undo: options.undo ?? null,
			at: this.ctx.now()
		};
		this.entries.push(entry);
		this.append(entry);
		return entry;
	}

	recovered(scope: string, code: string): void {
		const key = `${scope}/${code}`;
		this.states.set(key, recordRecovery(this.state(scope, code)));
		this.append({ kind: 'recovered', scope, code, at: this.ctx.now() });
	}

	/** the health tree, rendered locally so a box with the network down is still diagnosable */
	tree(): HealthNode {
		const byScope = new Map<string, LedgerEntry[]>();
		for (const entry of this.entries) {
			byScope.set(entry.finding.scope, [...(byScope.get(entry.finding.scope) ?? []), entry]);
		}
		const children: HealthNode[] = [];
		let overall: LogLevel = 'info';
		for (const [scope, found] of [...byScope].sort(([a], [b]) => a.localeCompare(b))) {
			let severity: LogLevel = 'info';
			for (const entry of found) severity = worse(severity, entry.finding.severity);
			overall = worse(overall, severity);
			children.push({
				name: scope,
				severity,
				detail: `${found.length} finding${found.length === 1 ? '' : 's'}`,
				children: found.map((entry) => ({
					name: entry.finding.code,
					severity: entry.finding.severity,
					detail: BY_CODE[entry.finding.code]?.means ?? '',
					children: []
				}))
			});
		}
		return { name: 'bastion', severity: overall, detail: '', children };
	}
}

export function renderTree(node: HealthNode, depth = 0): string {
	const mark = { debug: '.', info: 'ok', warn: '!', error: 'X', critical: 'XX' }[node.severity];
	const indent = '  '.repeat(depth);
	const detail = node.detail === '' ? '' : `  ${node.detail}`;
	return [
		`${indent}[${mark}] ${node.name}${detail}`,
		...node.children.map((child) => renderTree(child, depth + 1))
	].join('\n');
}

export interface Diagnosis {
	code: string;
	severity: LogLevel;
	means: string;
	button: string;
	occurrences: number;
	firstAt: number | null;
	lastAt: number | null;
	actionsTaken: { rung: Rung | null; reason: string; undo: string | null; at: number }[];
}

/**
 * Explains one code, including what bastion already did about it.
 *
 * An operator arriving at a broken box needs the second half more than the first: knowing that a
 * tenant was restarted twice and then quarantined is the difference between diagnosing the fault
 * and diagnosing the repair.
 */
export function diagnose(ledger: HealthLedger, code: string): Diagnosis | null {
	const tripwire = BY_CODE[code];
	if (tripwire === undefined) return null;
	const entries = ledger.all.filter((entry) => entry.finding.code === code);
	return {
		code,
		severity: tripwire.severity,
		means: tripwire.means,
		button: tripwire.button,
		occurrences: entries.length,
		firstAt: entries[0]?.finding.at ?? null,
		lastAt: entries[entries.length - 1]?.finding.at ?? null,
		actionsTaken: entries.map((entry) => ({
			rung: entry.rung,
			reason: entry.reason,
			undo: entry.undo,
			at: entry.at
		}))
	};
}
