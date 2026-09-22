import { describe, expect, it } from 'vitest';
import {
	AUTOMATIC,
	newLadderState,
	nextRung,
	QUARANTINE_STRIKES,
	recordFailure,
	recordRecovery,
	ROLLBACK_DWELL_MS,
	RUNG_CLASS,
	RUNGS
} from '../../../src/health/ladder';

describe('the vocabulary', () => {
	it('is the worker s ladder, in its order', () => {
		expect(RUNGS).toEqual([
			'observe',
			'reset',
			'reconstruct',
			'reconfigure',
			'quarantine',
			'rollback'
		]);
	});

	it('keeps the worker s constants', () => {
		expect(QUARANTINE_STRIKES).toBe(3);
		expect(ROLLBACK_DWELL_MS).toBe(30 * 60 * 1000);
	});

	it('classes only the first two as safe', () => {
		expect(RUNG_CLASS.observe).toBe('safe');
		expect(RUNG_CLASS.reset).toBe('safe');
		expect(RUNG_CLASS.reconstruct).toBe('rebuild');
		expect(RUNG_CLASS.quarantine).toBe('stateful');
	});
});

describe('nextRung', () => {
	it('records an info finding and acts on nothing', () => {
		expect(nextRung('info', newLadderState(), 0).rung).toBe(null);
	});

	it('only ever observes a warning', () => {
		expect(AUTOMATIC.warn).toEqual(['observe']);
		expect(nextRung('warn', newLadderState(), 0).rung).toBe('observe');
	});

	it('resets first at error', () => {
		expect(nextRung('error', newLadderState(), 0).rung).toBe('reset');
	});

	it('holds the rebuild class back while the host is shedding load', () => {
		const degraded = { ...newLadderState(), degraded: true };
		// reset is safe and still runs; the rebuild rung is what is withheld
		expect(nextRung('error', degraded, 0).rung).toBe('reset');
		const noSafe = { ...degraded, strikes: 0 };
		expect(RUNG_CLASS.reconstruct).toBe('rebuild');
		expect(nextRung('error', noSafe, 0).rung).not.toBe('reconstruct');
	});

	it('never runs anything stateful unattended', () => {
		const struck = { ...newLadderState(), strikes: QUARANTINE_STRIKES };
		const decision = nextRung('critical', struck, 0, { auto: true });
		expect(decision.rung).toBe(null);
		expect(decision.reason).toContain('never runs unattended');
	});

	it('quarantines by hand at three strikes', () => {
		const struck = { ...newLadderState(), strikes: QUARANTINE_STRIKES };
		expect(nextRung('critical', struck, 0).rung).toBe('quarantine');
	});

	it('does not quarantine at two', () => {
		const struck = { ...newLadderState(), strikes: 2 };
		expect(nextRung('critical', struck, 0).rung).not.toBe('quarantine');
	});

	it('rolls back only after the dwell, not immediately on quarantine', () => {
		const struck = { ...newLadderState(), strikes: QUARANTINE_STRIKES, quarantinedAt: 0 };
		expect(nextRung('critical', struck, ROLLBACK_DWELL_MS - 1).rung).toBe('quarantine');
		expect(nextRung('critical', struck, ROLLBACK_DWELL_MS).rung).toBe('rollback');
	});
});

describe('the strike counter', () => {
	it('counts up and remembers when it started', () => {
		const once = recordFailure(newLadderState(), 500);
		expect(once).toMatchObject({ strikes: 1, firstFailureAt: 500 });
		expect(recordFailure(once, 900).firstFailureAt).toBe(500);
	});

	it('clears on recovery but keeps whether the host is degraded', () => {
		const struck = { ...recordFailure(newLadderState(), 0), degraded: true };
		const recovered = recordRecovery(struck);
		expect(recovered.strikes).toBe(0);
		expect(recovered.degraded).toBe(true);
	});
});
