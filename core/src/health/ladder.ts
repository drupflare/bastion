import type { LogLevel } from '../config/types';

/**
 * The repair ladder, inherited from `worker/src/ops/repair.ts` rather than reinvented.
 *
 * A spec reads the sibling's source and fails when the two disagree, the `REQUIRE_SIBLINGS=1`
 * shape drangler already uses. A second vocabulary for the same ladder is the drift that costs a
 * correctness property.
 */
export const RUNGS = [
	'observe',
	'reset',
	'reconstruct',
	'reconfigure',
	'quarantine',
	'rollback'
] as const;
export type Rung = (typeof RUNGS)[number];

export const QUARANTINE_STRIKES = 3;
export const ROLLBACK_DWELL_MS = 30 * 60 * 1000;

/** what a rung costs, which is what decides whether it may run unattended */
export type RepairClass = 'safe' | 'rebuild' | 'stateful';

export const RUNG_CLASS: Record<Rung, RepairClass> = {
	observe: 'safe',
	reset: 'safe',
	reconstruct: 'rebuild',
	reconfigure: 'stateful',
	quarantine: 'stateful',
	rollback: 'stateful'
};

export const RUNG_ACTION: Record<Rung, string> = {
	observe: 'record it and change nothing',
	reset: "restart one tenant's process or VM, re-probe an adapter, reload the egress table",
	reconstruct: 'regenerate the capnp, rebuild the cache, re-index the object store',
	reconfigure: "lower a tenant's limits, fail a driver to its fallback, drop residency to evict",
	quarantine: 'stop the tenant, keep its state, serve a maintenance page',
	rollback: 'the previous bundle version or workerd pin'
};

/**
 * Which rungs run on their own, by severity.
 *
 * `warn` gets `observe` only: acting on a warning is how a transient becomes an outage. `error`
 * gets the three bounded rungs. `critical` adds quarantine after three strikes and rollback after
 * the dwell, neither of which is immediate.
 */
export const AUTOMATIC: Record<LogLevel, Rung[]> = {
	debug: [],
	info: [],
	warn: ['observe'],
	error: ['reset', 'reconstruct', 'reconfigure'],
	critical: ['reset', 'reconstruct', 'reconfigure', 'quarantine', 'rollback']
};

export interface LadderState {
	strikes: number;
	firstFailureAt: number | null;
	quarantinedAt: number | null;
	/** whether the host is shedding load, which bars the rebuild class */
	degraded: boolean;
}

export function newLadderState(): LadderState {
	return { strikes: 0, firstFailureAt: null, quarantinedAt: null, degraded: false };
}

export interface RungDecision {
	rung: Rung | null;
	reason: string;
}

/**
 * Which rung to run next.
 *
 * Two refusals are load-bearing. **The rebuild class is refused while the box is degraded**:
 * spending the resource a host is already shedding on is how a repair becomes the outage. And
 * `--auto` covers `safe` and `rebuild` only, so nothing `stateful` ever runs unattended.
 */
export function nextRung(
	severity: LogLevel,
	state: LadderState,
	now: number,
	options: { auto?: boolean } = {}
): RungDecision {
	const allowed = AUTOMATIC[severity] ?? [];
	if (allowed.length === 0) {
		return { rung: null, reason: `${severity} findings are recorded, not acted on` };
	}
	if (allowed.length === 1 && allowed[0] === 'observe') {
		return { rung: 'observe', reason: 'a warning is recorded, never acted on automatically' };
	}

	if (severity === 'critical' && state.strikes >= QUARANTINE_STRIKES) {
		const dwelled =
			state.quarantinedAt !== null && now - state.quarantinedAt >= ROLLBACK_DWELL_MS;
		if (dwelled) {
			if (options.auto === true) {
				return {
					rung: null,
					reason: 'rollback is stateful and never runs unattended; run it by hand'
				};
			}
			return {
				rung: 'rollback',
				reason: `quarantined for ${ROLLBACK_DWELL_MS}ms without recovering`
			};
		}
		if (options.auto === true) {
			return {
				rung: null,
				reason: 'quarantine is stateful and never runs unattended; run it by hand'
			};
		}
		return { rung: 'quarantine', reason: `${state.strikes} strikes` };
	}

	for (const rung of allowed) {
		const repairClass = RUNG_CLASS[rung];
		if (options.auto === true && repairClass === 'stateful') continue;
		if (state.degraded && repairClass === 'rebuild') continue;
		return {
			rung,
			reason:
				state.degraded && repairClass === 'rebuild'
					? ''
					: `${severity} at strike ${state.strikes + 1}`
		};
	}
	return {
		rung: null,
		reason: state.degraded
			? 'the host is shedding load, so the rebuild class is held back'
			: 'nothing at this severity runs unattended'
	};
}

export function recordFailure(state: LadderState, now: number): LadderState {
	return {
		...state,
		strikes: state.strikes + 1,
		firstFailureAt: state.firstFailureAt ?? now
	};
}

export function recordRecovery(state: LadderState): LadderState {
	return { ...newLadderState(), degraded: state.degraded };
}
