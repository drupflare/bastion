import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { QUARANTINE_STRIKES } from '../../../src/health/ladder';
import { HealthLedger, diagnose, renderTree } from '../../../src/health/ledger';
import { finding } from '../../../src/health/tripwires';
import { memoryIo } from '../../../src/io';

function ledger(now = () => 1000) {
	return new HealthLedger({ ...defaultContext(), io: memoryIo(), env: {}, now });
}

describe('HealthLedger', () => {
	it('records a finding with what was done about it', () => {
		const entry = ledger().record(finding('host.oom_kill', 'tenant/acme', 900));
		expect(entry.rung).toBe('reset');
		expect(entry.finding.severity).toBe('error');
	});

	it('keeps the undo, because break-glass matters more than the automation', () => {
		const entry = ledger().record(finding('host.oom_kill', 'tenant/acme', 900), {
			undo: 'bastion tenant limits acme --memory 4Gi'
		});
		expect(entry.undo).toContain('bastion tenant limits');
	});

	it('counts strikes per scope AND per code, so two tenants do not share a budget', () => {
		const log = ledger();
		log.record(finding('runtime.crash_loop', 'tenant/acme', 1));
		log.record(finding('runtime.crash_loop', 'tenant/acme', 2));
		expect(log.state('tenant/acme', 'runtime.crash_loop').strikes).toBe(2);
		expect(log.state('tenant/labs', 'runtime.crash_loop').strikes).toBe(0);
	});

	it('quarantines the third time and stamps when', () => {
		const log = ledger();
		for (let i = 0; i < QUARANTINE_STRIKES; i++) {
			log.record(finding('runtime.crash_loop', 'tenant/acme', i));
		}
		expect(log.all[QUARANTINE_STRIKES - 1]?.rung).toBe('quarantine');
		expect(log.state('tenant/acme', 'runtime.crash_loop').quarantinedAt).toBe(1000);
	});

	it('clears the strikes when the scope recovers', () => {
		const log = ledger();
		log.record(finding('runtime.crash_loop', 'tenant/acme', 1));
		log.recovered('tenant/acme', 'runtime.crash_loop');
		expect(log.state('tenant/acme', 'runtime.crash_loop').strikes).toBe(0);
	});

	it('marks every scope degraded at once, because the host is one thing', () => {
		const log = ledger();
		log.setDegraded(true);
		expect(log.state('tenant/acme', 'host.oom_kill').degraded).toBe(true);
	});

	it('refuses a code that is not in the table rather than raising it loose', () => {
		expect(() => finding('made.up', 'scope', 0)).toThrow(/not in the tripwire table/);
	});
});

describe('the health tree', () => {
	it('rolls the worst severity up to the root', () => {
		const log = ledger();
		log.record(finding('host.disk_low', 'host', 1));
		log.record(finding('audit.chain_broken', 'audit', 2));
		expect(log.tree().severity).toBe('critical');
	});

	it('is ok when nothing has been found', () => {
		expect(ledger().tree()).toMatchObject({ name: 'bastion', severity: 'info', children: [] });
	});

	it('groups by scope and renders locally, so a box with no network is diagnosable', () => {
		const log = ledger();
		log.record(finding('host.disk_low', 'host', 1));
		const text = renderTree(log.tree());
		expect(text).toContain('[!] bastion');
		expect(text).toContain('  [!] host');
		expect(text).toContain('    [!] host.disk_low');
	});
});

describe('diagnose', () => {
	it('explains a code and what bastion already did about it', () => {
		const log = ledger();
		log.record(finding('host.oom_kill', 'tenant/acme', 900), {
			undo: 'bastion tenant limits acme'
		});
		const explained = diagnose(log, 'host.oom_kill');
		expect(explained?.means).toContain('killed a tenant');
		expect(explained?.button).toBe('bastion repair host.oom_kill');
		expect(explained?.occurrences).toBe(1);
		expect(explained?.actionsTaken[0]?.rung).toBe('reset');
		expect(explained?.actionsTaken[0]?.undo).toBe('bastion tenant limits acme');
	});

	it('answers null for a code that is not a tripwire', () => {
		expect(diagnose(ledger(), 'made.up')).toBe(null);
	});

	it('explains a code that has never fired, rather than pretending it does not exist', () => {
		const explained = diagnose(ledger(), 'backup.stale');
		expect(explained?.occurrences).toBe(0);
		expect(explained?.button).toBe('bastion backup now');
	});
});
