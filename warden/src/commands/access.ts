import type { Context, Role } from '@drupflare/bastion';
import {
	AuditLog,
	BastionError,
	GRANTS,
	PROFILES,
	ROLES,
	TokenStore,
	ndjsonLine,
	syslogLine
} from '@drupflare/bastion';
import { kv, table } from '../format';
import { emit, load, type Globals } from '../state';

const TENANT_ROLES: Role[] = ['tenant-admin', 'tenant-viewer'];

function assertRole(value: string): Role {
	if (!(ROLES as readonly string[]).includes(value)) {
		throw new BastionError('usage', `${value} is not one of ${ROLES.join(', ')}`);
	}
	return value as Role;
}

// #region access

/**
 * Issues a tenant-scoped credential.
 *
 * `operator` is deliberately not issuable here: the operator credential is the claim token a first
 * run prints, and minting a second one from the CLI would make the strongest role the easiest to
 * hand out.
 */
export function runAccessInvite(
	ctx: Context,
	globals: Globals & { role?: string },
	tenant: string
): void {
	const loaded = load(ctx, globals);
	if (!loaded.config.tenants.some((entry) => entry.name === tenant)) {
		throw new BastionError('usage', `there is no tenant called ${tenant}`, {
			next: 'bastion tenant list'
		});
	}
	const role = assertRole(globals.role ?? 'tenant-admin');
	if (!TENANT_ROLES.includes(role)) {
		throw new BastionError(
			'capability-refused',
			`${role} is not issued by invitation; the operator credential is the claim token a ` +
				'first run prints',
			{ next: 'bastion access invite ' + tenant + ' --role tenant-admin' }
		);
	}

	const tokens = new TokenStore(ctx);
	const { token, secret } = tokens.create(`invite:${tenant}`, role, tenant);
	if (globals.json === true) {
		ctx.io.out(JSON.stringify({ id: token.id, role: token.role, tenant: token.tenant }));
		ctx.io.err(secret);
		return;
	}
	ctx.io.out(
		kv([
			['invited to', tenant],
			['role', role],
			['id', token.id],
			['may', GRANTS[role].join(', ')]
		])
	);
	ctx.io.out('');
	ctx.io.out(secret);
	ctx.io.out('that is the only time the secret is shown');
}

export function runAccessList(ctx: Context, globals: Globals): void {
	const tokens = new TokenStore(ctx);
	const issued = tokens.list().filter((token) => token.tenant !== null);
	emit(ctx, globals, { credentials: issued }, () =>
		issued.length === 0
			? 'nobody has been invited; `bastion access invite <tenant>` issues a credential'
			: table(
					['id', 'role', 'tenant', 'issued', 'state'],
					issued.map((token) => [
						token.id,
						token.role,
						token.tenant ?? '',
						new Date(token.createdAt).toISOString().slice(0, 10),
						token.revokedAt === null ? 'active' : 'revoked'
					])
				)
	);
}

export function runAccessRevoke(ctx: Context, globals: Globals, id: string): number {
	const tokens = new TokenStore(ctx);
	const revoked = tokens.revoke(id);
	emit(ctx, globals, { id, revoked }, () =>
		revoked ? `${id} is revoked and reaches nothing` : `there is no credential ${id}`
	);
	return revoked ? 0 : 3;
}

/**
 * Changes what a credential may do, by replacing it.
 *
 * A token's role is baked into what it resolves to, so raising or lowering one in place would let
 * a leaked secret gain scope it was never audited with. The old id is revoked and a new secret is
 * printed instead.
 */
export function runAccessRole(ctx: Context, globals: Globals, id: string, role: string): number {
	const tokens = new TokenStore(ctx);
	const existing = tokens.list().find((token) => token.id === id);
	if (existing === undefined) {
		throw new BastionError('usage', `there is no credential ${id}`, {
			next: 'bastion access list'
		});
	}
	const next = assertRole(role);
	if (!TENANT_ROLES.includes(next)) {
		throw new BastionError('capability-refused', `${next} is not issued by invitation`);
	}

	tokens.revoke(id);
	const { token, secret } = tokens.create(existing.name, next, existing.tenant);
	if (globals.json === true) {
		ctx.io.out(JSON.stringify({ revoked: id, id: token.id, role: next }));
		ctx.io.err(secret);
		return 0;
	}
	ctx.io.out(
		kv([
			['revoked', id],
			['issued', token.id],
			['role', next],
			['tenant', token.tenant ?? '(none)']
		])
	);
	ctx.io.out('');
	ctx.io.out(secret);
	ctx.io.out('the old secret no longer resolves');
	return 0;
}

// #endregion

// #region api tokens

export function runTokenList(ctx: Context, globals: Globals): void {
	const tokens = new TokenStore(ctx);
	const all = tokens.list();
	emit(ctx, globals, { tokens: all }, () =>
		all.length === 0
			? 'no API tokens have been created'
			: table(
					['id', 'name', 'role', 'tenant', 'state'],
					all.map((token) => [
						token.id,
						token.name,
						token.role,
						token.tenant ?? '(all)',
						token.revokedAt === null ? 'active' : 'revoked'
					])
				)
	);
}

export function runTokenRevoke(ctx: Context, globals: Globals, id: string): number {
	const tokens = new TokenStore(ctx);
	const revoked = tokens.revoke(id);
	emit(ctx, globals, { id, revoked }, () =>
		revoked ? `${id} is revoked` : `there is no token ${id}`
	);
	return revoked ? 0 : 3;
}

// #endregion

// #region audit

/** the chain in a form a SIEM reads; the default is NDJSON because syslog truncates long lines */
export function runAuditExport(
	ctx: Context,
	globals: Globals & { syslog?: boolean; ndjson?: boolean }
): void {
	const loaded = load(ctx, globals);
	const log = new AuditLog(ctx, `${loaded.state}/audit/audit.log`, loaded.config.audit);
	const events = log.read();
	const syslog = globals.syslog === true;
	const lines = events.map((event) => (syslog ? syslogLine(event) : ndjsonLine(event)));

	if (globals.json === true) {
		ctx.io.out(JSON.stringify({ format: syslog ? 'syslog' : 'ndjson', events }));
		return;
	}
	for (const line of lines) ctx.io.out(line);
	if (lines.length === 0) ctx.io.err('the audit log is empty');
}

/** what the configured profile actually records, which is not obvious from its name */
export function runAuditProfile(ctx: Context, globals: Globals): void {
	const loaded = load(ctx, globals);
	const active = loaded.config.audit.profile;
	const profile = PROFILES[active];
	const overrides = Object.entries(loaded.config.audit.events ?? {});
	emit(ctx, globals, { profile: active, ...profile, overrides }, () =>
		[
			kv([
				['profile', active],
				['records from', profile.minimum],
				['configured level', loaded.config.audit.level]
			]),
			'',
			table(
				['event', 'recorded', 'from'],
				[
					...Object.entries(profile.events).map(([event, on]) => [
						event,
						on ? 'yes' : 'no',
						'profile'
					]),
					...overrides.map(([event, on]) => [event, on === true ? 'yes' : 'no', 'config'])
				]
			),
			'',
			'every other event is recorded when its level reaches the minimum above'
		].join('\n')
	);
}

// #endregion
