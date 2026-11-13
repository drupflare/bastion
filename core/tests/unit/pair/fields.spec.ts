import { describe, expect, it } from 'vitest';
import { AuditLog } from '../../../src/audit/log';
import { HealthLedger } from '../../../src/health/ledger';
import { finding } from '../../../src/health/tripwires';
import { AnalyticsWindow } from '../../../src/observe/analytics';
import {
	auditHeadBody,
	capacityNumbers,
	commandResultBody,
	fieldGroups,
	findingsBody,
	hostFacts,
	keepListed,
	metricsBody,
	nameOf,
	statusBody,
	usageBody,
	type FieldInput
} from '../../../src/pair/fields';
import { LEAVES_THE_BOX, NEVER_LEAVES_THE_BOX, nodeBodyOk } from '../../../src/pair/wire';
import { NODE_ID, STATE, newBox } from './plane';

/** values a builder must never carry, planted everywhere a careless one could read from */
const PLANTED = {
	secret: 'sk_live_PLANTED_SECRET_VALUE',
	content: '<h1>PLANTED_SITE_CONTENT</h1>',
	env: 'PLANTED_ENV_VALUE_4471',
	log: 'PLANTED_LOG_BODY_user@example.edu logged in',
	password: 'PLANTED_DB_PASSWORD',
	finding: 'PLANTED_FINDING_CONTEXT /var/www/private/file.php',
	hostname: 'planted-hostname.internal.example.edu',
	bundle: '/srv/PLANTED_BUNDLE_PATH.tgz'
};

function seeded() {
	const box = newBox({
		tenants: [
			{
				name: 'acme',
				sites: [
					{
						host: 'www.example.edu',
						bundle: PLANTED.bundle,
						worker: {
							hyperdrive: [
								{
									name: 'DB',
									database: 'd',
									user: 'u',
									password: PLANTED.password,
									scheme: 'postgres'
								}
							]
						},
						bindings: { TOKEN: PLANTED.secret }
					}
				]
			}
		],
		tls: { acme: { email: PLANTED.env } },
		backup: { target: { driver: 's3', secretAccessKey: PLANTED.secret } }
	});
	box.ctx.env.AWS_SECRET_ACCESS_KEY = PLANTED.env;
	box.ctx.env.BASTION_SECRET_DB = PLANTED.secret;
	box.files.writeText(`${STATE}/logs/acme.log`, `${PLANTED.log}\n`);
	box.files.writeText(`${STATE}/tenants/acme/index.html`, PLANTED.content);
	const ledger = new HealthLedger(box.ctx, STATE);
	ledger.record(
		finding('host.disk_low', 'host', box.clock.now, {
			detail: PLANTED.finding,
			path: PLANTED.bundle
		})
	);
	ledger.record(finding('host.disk_low', 'acme', box.clock.now, { detail: PLANTED.finding }));
	new AuditLog(box.ctx, `${STATE}/audit.ndjson`, box.config.audit).record({
		at: box.clock.now,
		event: 'tenant.added',
		level: 'info',
		principal: 'operator',
		detail: { note: PLANTED.log }
	});
	const analytics = new AnalyticsWindow(10_000);
	for (let i = 0; i < 6; i += 1) {
		analytics.record({
			at: box.clock.now - 60_000 + i,
			tenant: 'acme',
			site: 'www.example.edu',
			status: i === 0 ? 500 : 200,
			durationMs: 20 + i,
			bytes: 1000,
			cached: i % 2 === 0,
			refusal: null
		});
	}
	const input: FieldInput = {
		ctx: box.ctx,
		config: box.config,
		state: STATE,
		nodeId: NODE_ID,
		hostname: PLANTED.hostname,
		arch: 'arm64'
	};
	return { box, input, analytics };
}

function everyBody() {
	const { box, input, analytics } = seeded();
	const log = new AuditLog(box.ctx, `${STATE}/audit.ndjson`, box.config.audit);
	const day = 3_600_000;
	const now = Math.floor(box.clock.now / day) * day + day + 10_000;
	const window = { from: box.clock.now - 300_000, to: box.clock.now };
	const hourly = new AnalyticsWindow(10_000);
	hourly.record({
		at: now - day - 5_000,
		tenant: 'acme',
		site: 'www.example.edu',
		status: 200,
		durationMs: 5,
		bytes: 10,
		cached: false,
		refusal: null
	});
	return {
		status: statusBody(input),
		findings: findingsBody(input),
		'metrics.batch': metricsBody(input, window, analytics),
		'audit.head': auditHeadBody(log),
		'usage.report': usageBody(
			{ nodeId: NODE_ID, now, siteIds: { 'www.example.edu': 'site_testsite0001' } },
			hourly,
			now - day
		),
		'command.result': commandResultBody(
			{ opId: 'op_testop000001', stepId: 'step-1', idempotencyKey: 'idem-1' },
			{ outcome: 'succeeded', code: null, deploy: null }
		)
	};
}

describe('what leaves the box', () => {
	it('carries none of a state seeded with secrets, content, environment values and log bodies', () => {
		const bodies = everyBody();
		for (const [type, body] of Object.entries(bodies)) {
			expect(body, type).not.toBeNull();
			const text = JSON.stringify(body);
			for (const [what, value] of Object.entries(PLANTED)) {
				expect(text, `${type} carried the planted ${what}`).not.toContain(value);
			}
		}
	});

	it('builds a body the contract accepts for every message type it sends', () => {
		for (const [type, body] of Object.entries(everyBody())) {
			expect(nodeBodyOk(type as never, body), type).toBe(true);
		}
	});

	it('uses only keys the contract lists for the type', () => {
		for (const [type, body] of Object.entries(everyBody())) {
			const listed = new Set(
				LEAVES_THE_BOX.filter((e) => e.type === type).map((e) => e.field)
			);
			for (const key of Object.keys(body as object)) {
				expect(listed.has(key), `${type}.${key}`).toBe(true);
			}
		}
	});

	it('drops a field the contract does not list even when a builder is handed one', () => {
		const { input } = seeded();
		const body = statusBody({
			...input,
			config: { ...input.config, mode: 'solo' }
		}) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(
			[
				'arch',
				'bastionVersion',
				'capacity',
				'mode',
				'namesHashed',
				'nodeId',
				'os',
				'sites',
				'tenants',
				'workerdVersion'
			].sort()
		);
	});

	it('removes any key the contract does not list, at the top level', () => {
		const kept = keepListed('audit.head', {
			seq: 1,
			hash: 'sha256:' + '0'.repeat(64),
			note: PLANTED.log,
			path: PLANTED.bundle
		});
		expect(kept).toEqual({ seq: 1, hash: 'sha256:' + '0'.repeat(64) });
	});

	it('sends the host name only when the operator allows it', () => {
		const { input } = seeded();
		expect(hostFacts(input)).not.toHaveProperty('hostname');
		const allowed = hostFacts({
			...input,
			config: {
				...input.config,
				pairing: {
					sendHostname: true,
					hashNames: false,
					commands: {
						safe: 'queue',
						rebuild: 'queue',
						stateful: 'queue',
						destructive: 'queue'
					}
				}
			}
		});
		expect(allowed.hostname).toBe(PLANTED.hostname);
	});

	it('sends names as typed by default and as a per-node digest when the operator chooses', () => {
		const { input } = seeded();
		const plain = statusBody(input);
		expect(plain.tenants).toEqual(['acme']);
		expect(plain.sites).toEqual(['www.example.edu']);
		expect(plain.namesHashed).toBe(false);

		const hashed = statusBody({
			...input,
			config: {
				...input.config,
				pairing: {
					sendHostname: false,
					hashNames: true,
					commands: {
						safe: 'queue',
						rebuild: 'queue',
						stateful: 'queue',
						destructive: 'queue'
					}
				}
			}
		});
		expect(hashed.namesHashed).toBe(true);
		expect(JSON.stringify(hashed)).not.toContain('acme');
		expect(JSON.stringify(hashed)).not.toContain('www.example.edu');
		expect(nameOf('acme', NODE_ID, true)).not.toBe(nameOf('acme', 'nod_otherbox0001', true));
		expect(nameOf('acme', NODE_ID, true)).toBe(nameOf('acme', NODE_ID, true));
	});

	it('reports finding codes with a site and a count, never the context', () => {
		const { input } = seeded();
		const { findings } = findingsBody(input);
		expect(findings).toEqual([
			{ code: 'host.disk_low', site: null, count: 1 },
			{ code: 'host.disk_low', site: 'acme', count: 1 }
		]);
	});

	it('reports the audit chain length and head, and nothing it recorded', () => {
		const { box } = seeded();
		const log = new AuditLog(box.ctx, `${STATE}/audit.ndjson`, box.config.audit);
		const body = auditHeadBody(log);
		expect(body).toEqual({ seq: 1, hash: `sha256:${log.chainHead}` });
	});

	it('counts capacity from the box and leaves out what it could not read', () => {
		const { input } = seeded();
		const numbers = capacityNumbers(input);
		expect(numbers).toMatchObject({ tenantsUsed: 1, sitesUsed: 1 });
		for (const value of Object.values(numbers)) expect(Number.isFinite(value)).toBe(true);
	});

	it('names metrics points with codes and sends no log line', () => {
		const { input, analytics, box } = seeded();
		const body = metricsBody(
			input,
			{ from: box.clock.now - 120_000, to: box.clock.now },
			analytics
		);
		expect(body.requests).toBe(6);
		expect(body.points.map((point) => point.name)).toEqual([
			'requests',
			'requests.errors',
			'requests.refused',
			'cache.fraction',
			'latency.p95.ms',
			'response.bytes'
		]);
		expect(body.windowStart).toMatch(/Z$/);
	});

	it('builds usage only for a site the control plane named, as completed hours', () => {
		const hour = 3_600_000;
		const now = 1_790_000_000_000;
		const start = Math.floor(now / hour) * hour - hour;
		const analytics = new AnalyticsWindow(100);
		for (const site of ['www.example.edu', 'unnamed.example.edu']) {
			analytics.record({
				at: start + 1000,
				tenant: 'acme',
				site,
				status: 200,
				durationMs: 1,
				bytes: 1,
				cached: false,
				refusal: null
			});
		}
		const body = usageBody(
			{ nodeId: NODE_ID, now, siteIds: { 'www.example.edu': 'site_testsite0001' } },
			analytics,
			start
		);
		expect(body!.intervals).toEqual([
			{
				siteId: 'site_testsite0001',
				start: new Date(start).toISOString().replace('.000Z', 'Z'),
				end: new Date(start + hour).toISOString().replace('.000Z', 'Z'),
				accuracy: 'exact',
				views: 1,
				lowerBound: 1,
				observedViews: 1,
				settlement: 'open'
			}
		]);
		expect(usageBody({ nodeId: NODE_ID, now, siteIds: {} }, analytics, start)).toBeNull();
	});

	it('calls an hour estimated when the request window may have dropped samples from it', () => {
		const hour = 3_600_000;
		const now = 1_790_000_000_000;
		const start = Math.floor(now / hour) * hour - 2 * hour;
		const analytics = new AnalyticsWindow(3);
		for (let i = 0; i < 5; i += 1) {
			analytics.record({
				at: start + hour + i,
				tenant: 'acme',
				site: 'www.example.edu',
				status: 200,
				durationMs: 1,
				bytes: 1,
				cached: false,
				refusal: null
			});
		}
		const body = usageBody(
			{ nodeId: NODE_ID, now, siteIds: { 'www.example.edu': 'site_testsite0001' } },
			analytics,
			start
		);
		const first = body!.intervals as { accuracy: string; start: string }[];
		expect(first.every((interval) => interval.accuracy === 'estimated')).toBe(true);
	});

	it('refuses to build a body the contract would reject', () => {
		expect(() =>
			commandResultBody(
				{ opId: 'not-an-op', stepId: 'step-1', idempotencyKey: 'k' },
				{ outcome: 'succeeded', code: null, deploy: null }
			)
		).toThrow('does not satisfy');
	});

	it('prints the list from the contract, and names what never leaves', () => {
		const { leaves, never } = fieldGroups();
		expect(leaves.map((group) => group.type)).toEqual([
			'status',
			'findings',
			'metrics.batch',
			'audit.head',
			'usage.report',
			'command.result'
		]);
		expect(leaves.flatMap((group) => group.fields)).toHaveLength(LEAVES_THE_BOX.length);
		expect(never).toEqual(NEVER_LEAVES_THE_BOX);
	});
});
