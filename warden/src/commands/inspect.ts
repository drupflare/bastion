import type { Context } from '@drupflare/bastion';
import {
	BastionError,
	HealthLedger,
	LogWriter,
	Registry,
	TRIPWIRES,
	capacity,
	defaultCostModel,
	diagnose,
	installTool,
	preflight,
	probeOptional,
	readHost,
	renderTree
} from '@drupflare/bastion';
import { kv, table } from '../format';
import { emit, load, type Globals } from '../state';
import { VERSION } from '../version';

export function runStatus(ctx: Context, globals: Globals): void {
	const loaded = load(ctx, globals);
	const report = preflight(ctx);
	const tenants = loaded.config.tenants.map((tenant) => ({
		tenant: tenant.name,
		sites: tenant.sites.length,
		limits: tenant.limits ?? {}
	}));
	emit(ctx, globals, { mode: loaded.config.mode, platform: report.platform, tenants }, () =>
		tenants.length === 0
			? 'no tenants are configured'
			: table(
					['tenant', 'sites', 'cpu', 'memory'],
					tenants.map((t) => [
						t.tenant,
						String(t.sites),
						String(t.limits.cpu ?? 'max'),
						String(t.limits.memory ?? 'max')
					])
				)
	);
}

export function runHealth(ctx: Context, globals: Globals & { tree?: boolean }): void {
	const ledger = new HealthLedger(ctx);
	const tree = ledger.tree();
	emit(ctx, globals, { severity: tree.severity, tree }, () =>
		globals.tree === true ? renderTree(tree) : `health: ${tree.severity}`
	);
}

export function runDiagnose(ctx: Context, globals: Globals & { code?: string }): void {
	const ledger = new HealthLedger(ctx);
	if (globals.code === undefined) {
		emit(ctx, globals, { tripwires: TRIPWIRES }, () =>
			table(
				['code', 'severity', 'button'],
				TRIPWIRES.map((t) => [t.code, t.severity, t.button])
			)
		);
		return;
	}
	const explained = diagnose(ledger, globals.code);
	if (explained === null) {
		ctx.io.err(`${globals.code} is not a tripwire; run \`bastion diagnose\` for the list`);
		return;
	}
	emit(ctx, globals, explained, () =>
		kv([
			['code', explained.code],
			['severity', explained.severity],
			['means', explained.means],
			['run', explained.button],
			['seen', String(explained.occurrences)]
		])
	);
}

export function runCapacity(ctx: Context, globals: Globals & { whatIf?: string }): void {
	const loaded = load(ctx, globals);
	const host = readHost(ctx, loaded.state);
	const model = defaultCostModel(loaded.config.mode);
	const answer = capacity(host, model, {
		residency: loaded.config.runtime.residency,
		tenants: Math.max(1, loaded.config.tenants.length)
	});
	emit(ctx, globals, answer, () =>
		[
			kv([
				['recommended', answer.known ? String(answer.recommended) : 'not measured'],
				['maximum', answer.known ? String(answer.maximum) : 'not measured'],
				['bound by', answer.bindingTerm],
				['provenance', answer.provenance],
				[
					'concurrency ceiling',
					answer.concurrencyCeiling === null
						? '(not applicable)'
						: String(answer.concurrencyCeiling)
				]
			]),
			'',
			table(
				['term', 'value', 'unit', 'provenance', 'source'],
				answer.terms.map((t) => [
					t.name,
					String(Math.round(t.value)),
					t.unit,
					t.provenance,
					t.source
				])
			),
			'',
			...answer.notes.map((note) => `note: ${note}`)
		].join('\n')
	);
}

export function runMetrics(ctx: Context, globals: Globals): void {
	const loaded = load(ctx, globals);
	const registry = new Registry(loaded.config.cluster?.node.id ?? 'local');
	for (const tenant of loaded.config.tenants) {
		registry.gauge('bastion_tenant_sites', 'sites held by a tenant', tenant.sites.length, {
			tenant: tenant.name
		});
	}
	ctx.io.out(registry.render());
}

export function runLogs(
	ctx: Context,
	globals: Globals & { level?: string; tenant?: string }
): void {
	const loaded = load(ctx, globals);
	const writer = new LogWriter(ctx, `${loaded.state}/logs`, loaded.config.logs);
	const level = (globals.level ?? 'info') as 'debug' | 'info';
	const lines = writer
		.read(level, 200)
		.filter((line) => globals.tenant === undefined || line.tenant === globals.tenant);
	emit(ctx, globals, { lines }, () =>
		lines.length === 0
			? 'no log lines at that level yet'
			: lines.map((l) => l.message).join('\n')
	);
}

/**
 * What each optional binding needs and whether this host has it.
 *
 * Exits 3 when something is missing rather than 0, because an operator running this in a
 * provisioning script wants a non-zero code on "the box cannot do what the config asks for". It is
 * a finding rather than a failure: nothing is broken, something is simply not installed.
 */
export async function runCapabilityList(ctx: Context, globals: Globals): Promise<number> {
	const report = await probeOptional(ctx);
	const missing = report.filter((entry) => entry.state === 'absent');
	emit(ctx, globals, { capabilities: report }, () =>
		[
			table(
				['binding', 'command', 'state', 'size', 'what it is for'],
				report.map((entry) => [
					entry.slot,
					entry.command,
					entry.state === 'present' ? (entry.version ?? 'present') : 'not installed',
					`~${entry.approxMb} MB`,
					entry.why
				])
			),
			...(missing.length === 0
				? ['', 'every optional binding has its software']
				: [
						'',
						'to install what is missing:',
						...missing.map((entry) => `  ${entry.install}`),
						'',
						'or run `bastion capability install <binding>`, which runs exactly that'
					])
		].join('\n')
	);
	return missing.length === 0 ? 0 : 3;
}

/**
 * Installs the software one binding needs.
 *
 * Privileged, so it is never implicit: no site binding a capability triggers this, and `up` does
 * not run it on an operator's behalf. It prints the command it is about to run before running it,
 * because a tool that installs packages should not be the one thing an operator cannot audit.
 */
export async function runCapabilityInstall(
	ctx: Context,
	globals: Globals,
	slot: string
): Promise<number> {
	const before = (await probeOptional(ctx)).find((entry) => entry.slot === slot);
	if (before === undefined) {
		throw new BastionError('usage', `${slot} is not an optional binding`, {
			next: 'bastion capability list'
		});
	}
	if (before.state === 'present') {
		emit(
			ctx,
			globals,
			{ slot, installed: false, already: true },
			() => `${slot} already has ${before.command}: ${before.version ?? 'present'}`
		);
		return 0;
	}

	ctx.io.err(`running: ${before.install}`);
	const answer = await installTool(ctx, slot);
	emit(ctx, globals, { slot, installed: answer.ok, command: answer.command }, () =>
		answer.ok
			? `installed ${slot}: ${answer.command}`
			: `could not install ${slot}\n${answer.output}`
	);
	return answer.ok ? 0 : 1;
}

export function runVersion(ctx: Context, globals: Globals): void {
	const loaded = load(ctx, globals);
	emit(ctx, globals, { bastion: VERSION, workerd: loaded.config.runtime.workerd.version }, () =>
		kv([
			['bastion', VERSION],
			['workerd pin', loaded.config.runtime.workerd.version],
			['floor', loaded.config.runtime.floors.workerd]
		])
	);
}
