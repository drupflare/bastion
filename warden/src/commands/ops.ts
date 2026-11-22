import type { Context } from '@drupflare/bastion';
import {
	AuditLog,
	BastionError,
	CertificateStore,
	EXPIRY_LADDER,
	HOST_SCOPE,
	NEVER_REACHABLE,
	acceptedCves,
	buildSecrets,
	checkPinChange,
	expirySeverity,
	formatFor,
	nftablesProgram,
	redact,
	rolloutPlan,
	rulesFor,
	tenantScope,
	wouldAllow,
	type SecretStore
} from '@drupflare/bastion';
import { kv, table, yesNo } from '../format';
import { emit, load, type Globals } from '../state';

function tenantNamed(ctx: Context, globals: Globals, name: string) {
	const loaded = load(ctx, globals);
	const tenant = loaded.config.tenants.find((entry) => entry.name === name);
	if (tenant === undefined) throw new BastionError('usage', `there is no tenant called ${name}`);
	return { loaded, tenant };
}

export function runEgressShow(ctx: Context, globals: Globals & { tenant?: string }): void {
	const loaded = load(ctx, globals);
	const tenants =
		globals.tenant === undefined
			? loaded.config.tenants
			: loaded.config.tenants.filter((t) => t.name === globals.tenant);
	const policies = tenants.map((tenant) => ({
		tenant: tenant.name,
		rules: rulesFor(tenant),
		program: nftablesProgram(tenant.name, rulesFor(tenant))
	}));
	emit(ctx, globals, { policies, neverReachable: NEVER_REACHABLE }, () =>
		policies.length === 0
			? 'no tenants are configured'
			: policies
					.map((policy) =>
						[
							`tenant ${policy.tenant}`,
							policy.rules.length === 0
								? '  (no allow list; everything is denied)'
								: policy.rules
										.map((rule) => `  allow ${rule.host}:${rule.port}`)
										.join('\n')
						].join('\n')
					)
					.join('\n\n')
	);
}

export function runEgressTest(
	ctx: Context,
	globals: Globals,
	tenantName: string,
	target: string
): number {
	const { tenant } = tenantNamed(ctx, globals, tenantName);
	const answer = wouldAllow(rulesFor(tenant), target);
	emit(
		ctx,
		globals,
		{ tenant: tenantName, target, ...answer },
		() => `${answer.allowed ? 'allowed' : 'denied'}: ${answer.reason}`
	);
	return answer.allowed ? 0 : 3;
}

export function runCertList(ctx: Context, globals: Globals): void {
	const loaded = load(ctx, globals);
	const store = new CertificateStore(ctx, `${loaded.state}/certs`);
	const rows = store.list().map((host) => {
		const certificate = store.load(host);
		return {
			host,
			expiresAt: certificate?.expiresAt ?? 0,
			severity: certificate === null ? 'expired' : expirySeverity(certificate, ctx.now()),
			source: certificate?.source ?? 'unknown'
		};
	});
	emit(ctx, globals, { certificates: rows, ladder: EXPIRY_LADDER }, () =>
		rows.length === 0
			? 'no certificates are stored yet'
			: table(
					['host', 'expires', 'state', 'source'],
					rows.map((row) => [
						row.host,
						new Date(row.expiresAt).toISOString().slice(0, 10),
						row.severity,
						row.source
					])
				)
	);
}

/**
 * The store a secrets command acts on, and the scope it chose.
 *
 * Without `--tenant` that is the host scope, which holds the node key and every secret that
 * existed before scopes did, and every command says so in its output. With it, the same store
 * narrowed to that tenant, so a command can never reach the other scope by naming a secret.
 *
 * `mustExist` is for commands that create something: a typo in `--tenant` must not start a scope
 * no tenant will ever read. Removal and listing accept a tenant that is gone, because its secrets
 * outlive it and somebody has to be able to clear them.
 */
export function secretScope(
	ctx: Context,
	globals: Globals & { tenant?: string },
	mustExist = false
): { store: SecretStore; scope: string; label: string; state: string } {
	const loaded = load(ctx, globals);
	const host = buildSecrets(ctx, loaded.config.drivers.secrets);
	if (globals.tenant === undefined) {
		return { store: host, scope: HOST_SCOPE, label: 'host scope', state: loaded.state };
	}
	if (mustExist && !loaded.config.tenants.some((entry) => entry.name === globals.tenant)) {
		throw new BastionError('usage', `there is no tenant called ${globals.tenant}`, {
			next: 'bastion tenant list'
		});
	}
	const scope = tenantScope(globals.tenant);
	return {
		store: host.scope(scope),
		scope,
		label: `${globals.tenant} scope`,
		state: loaded.state
	};
}

export async function runSecretsList(
	ctx: Context,
	globals: Globals & { tenant?: string }
): Promise<void> {
	const { store, scope, label } = secretScope(ctx, globals);
	const secrets = await store.list();
	emit(ctx, globals, { driver: store.id(), scope, secrets }, () =>
		secrets.length === 0
			? `the ${store.id()} store holds nothing in the ${label} that bastion can enumerate`
			: [
					label,
					table(
						['name', 'driver', 'updated'],
						secrets.map((secret) => [
							secret.name,
							secret.driver,
							secret.updatedAt === 0 ? '-' : new Date(secret.updatedAt).toISOString()
						])
					)
				].join('\n')
	);
}

/** `get` prints the value on stdout and NEVER inside the --json payload */
export async function runSecretsGet(
	ctx: Context,
	globals: Globals & { tenant?: string },
	name: string
): Promise<void> {
	const { store, scope } = secretScope(ctx, globals);
	const value = await store.get(name);
	if (value === null) throw new BastionError('usage', `no secret called ${name} in ${scope}`);
	if (globals.json === true) {
		ctx.io.out(JSON.stringify({ name, driver: store.id(), scope, value: redact(value) }));
		return;
	}
	ctx.io.out(value);
}

export function runUpdateCheck(ctx: Context, globals: Globals & { to?: string }): number {
	const loaded = load(ctx, globals);
	const from = {
		version: loaded.config.runtime.workerd.version,
		sha256: '',
		storageFormat: formatFor(loaded.config.runtime.workerd.version)
	};
	if (globals.to === undefined) {
		emit(ctx, globals, { current: from }, () =>
			kv([
				['pinned', from.version],
				['storage format', from.storageFormat],
				['floor', loaded.config.runtime.floors.workerd]
			])
		);
		return 0;
	}
	const to = { version: globals.to, sha256: '', storageFormat: formatFor(globals.to) };
	const refusal = checkPinChange(from, to, { floor: loaded.config.runtime.floors.workerd });
	emit(ctx, globals, { from, to, ...refusal, accepts: acceptedCves(to) }, () =>
		refusal.ok
			? `${globals.to} may be applied`
			: refusal.reasons.map((reason) => `refused: ${reason}`).join('\n')
	);
	return refusal.ok ? 0 : 3;
}

export function runRollout(
	ctx: Context,
	globals: Globals & { percent?: string },
	_host: string
): void {
	const loaded = load(ctx, globals);
	const percent = Number(globals.percent ?? '100');
	const plan = rolloutPlan(
		loaded.config.tenants.map((tenant) => tenant.name),
		percent
	);
	emit(ctx, globals, { plan }, () =>
		plan.length === 0
			? 'there are no tenants to roll out to'
			: table(
					['order', 'tenant', 'canary'],
					plan.map((step) => [String(step.order), step.tenant, yesNo(step.canary)])
				)
	);
}

export function runAuditVerify(ctx: Context, globals: Globals): number {
	const loaded = load(ctx, globals);
	const log = new AuditLog(ctx, `${loaded.state}/audit.ndjson`, loaded.config.audit);
	const result = log.verify();
	emit(ctx, globals, { ...result, entries: log.length, head: log.chainHead }, () =>
		result.ok
			? `the chain of ${log.length} entries verifies`
			: `the chain breaks at entry ${result.brokenAt}: ${result.reason}`
	);
	return result.ok ? 0 : 3;
}

export function runAuditTail(ctx: Context, globals: Globals): void {
	const loaded = load(ctx, globals);
	const log = new AuditLog(ctx, `${loaded.state}/audit.ndjson`, loaded.config.audit);
	const entries = log.read().slice(-50);
	emit(ctx, globals, { entries }, () =>
		entries.length === 0
			? 'the audit log is empty'
			: table(
					['seq', 'at', 'event', 'principal'],
					entries.map((entry) => [
						String(entry.seq),
						new Date(entry.at).toISOString(),
						entry.event,
						entry.principal
					])
				)
	);
}
