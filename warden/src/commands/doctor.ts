import {
	checkFloor,
	EXIT,
	LIMIT_FLOORS,
	loadConfig,
	MODE_TABLE,
	modeAvailable,
	preflight,
	VERSION_FLOORS,
	type Context
} from '@drupflare/bastion';
import { kv, table, yesNo } from '../format';

export interface DoctorOptions {
	json?: boolean;
	config?: string;
}

/**
 * What this host can and cannot do.
 *
 * The limits table is the load-bearing half. Standalone workerd enforces NOTHING -- no isolate
 * cap, no CPU limit, no subrequest cap, no startup budget -- so bastion prints what it enforces,
 * at what granularity, and what it can only declare. A limit bastion cannot enforce is never
 * reported as enforced.
 */
export function runDoctor(ctx: Context, options: DoctorOptions = {}): number {
	const loaded = loadConfig(ctx, { path: options.config });
	const report = preflight(ctx);
	const mode = loaded.config.mode;
	const availability = modeAvailable(report, mode);
	const floor = checkFloor(
		'workerd',
		loaded.config.runtime.workerd.version,
		loaded.config.runtime.floors.workerd ?? VERSION_FLOORS.workerd
	);

	const limits = [
		{
			limit: 'isolate memory',
			cloudflare: `${LIMIT_FLOORS.isolateMemory}`,
			workerd: 'none',
			bastion: 'enforced per TENANT (cgroup), declared per isolate'
		},
		{ limit: 'cpu', cloudflare: 'enforced', workerd: 'none', bastion: 'enforced per tenant' },
		{
			limit: 'subrequests',
			cloudflare: `${LIMIT_FLOORS.subrequests}`,
			workerd: 'none',
			bastion: 'declared, not enforced'
		},
		{
			limit: 'startup ms',
			cloudflare: `${LIMIT_FLOORS.startupMs}`,
			workerd: 'none',
			bastion: 'declared, not enforced'
		},
		{
			limit: 'alarm',
			cloudflare: `${LIMIT_FLOORS.alarmMs}`,
			workerd: `${LIMIT_FLOORS.alarmMs}`,
			bastion: `inherited, ${loaded.config.runtime.limits.alarmMs}ms configured`
		}
	];

	const payload = {
		ok: availability.ok && floor.ok,
		platform: report.platform,
		mode,
		modeAvailable: availability.ok,
		modeMissing: availability.missing,
		multiTenantSafe: MODE_TABLE[mode].multiTenantSafe,
		mechanisms: report.mechanisms,
		availableModes: report.available,
		runtime: {
			version: loaded.config.runtime.workerd.version,
			floor: loaded.config.runtime.floors.workerd,
			clearsFloor: floor.ok,
			reason: floor.ok ? null : floor.message
		},
		limits
	};

	if (options.json === true) {
		ctx.io.out(JSON.stringify(payload));
		return payload.ok ? EXIT.OK : EXIT.FINDING;
	}

	ctx.io.out(
		kv([
			['platform', report.platform],
			['config', loaded.path ?? '(defaults; no file)'],
			['mode', `${mode} (${MODE_TABLE[mode].boundary})`],
			['multi-tenant safe', yesNo(MODE_TABLE[mode].multiTenantSafe)],
			['mode available here', availability.ok ? 'yes' : `no: ${availability.message}`],
			['workerd', loaded.config.runtime.workerd.version],
			['clears the floor', floor.ok ? 'yes' : `no: ${floor.message}`]
		])
	);
	ctx.io.out('');
	ctx.io.out(
		table(
			['mechanism', 'present', 'source', 'detail'],
			report.mechanisms.map((m) => [m.label, yesNo(m.present), m.source, m.detail])
		)
	);
	ctx.io.out('');
	ctx.io.out(
		table(
			['limit', 'cloudflare', 'standalone workerd', 'bastion'],
			limits.map((l) => [l.limit, l.cloudflare, l.workerd, l.bastion])
		)
	);

	// a finding rather than a failure: doctor ran, and what it found is that this host cannot do
	// what the configuration asks for
	return payload.ok ? EXIT.OK : EXIT.FINDING;
}
