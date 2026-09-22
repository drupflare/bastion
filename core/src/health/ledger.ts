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

/**
 * What was found, what was done about it, and how to undo it.
 *
 * The `undo` column is the part that matters more than the automation. Break-glass is the
 * requirement: every automatic repair records what it did, is reversible, and `bastion diagnose`
 * explains it. A repair nobody can reverse is a repair nobody should have run.
 */
export class HealthLedger {
	private readonly ctx: Context;
	private readonly entries: LedgerEntry[] = [];
	private readonly states = new Map<string, LadderState>();
	private degraded = false;

	constructor(ctx: Context) {
		this.ctx = ctx;
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
		return entry;
	}

	recovered(scope: string, code: string): void {
		const key = `${scope}/${code}`;
		this.states.set(key, recordRecovery(this.state(scope, code)));
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
