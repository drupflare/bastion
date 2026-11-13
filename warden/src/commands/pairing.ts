import type { CommandRecord, Context, PairingRecord } from '@drupflare/bastion';
import {
	BastionError,
	CommandBook,
	DEFAULT_PAIRING,
	NodeKey,
	PairStore,
	auditPair,
	buildSecrets,
	claim,
	fieldGroups
} from '@drupflare/bastion';
import { hostname } from 'node:os';
import { kv, table, yesNo } from '../format';
import { fleetExecutors } from '../pair';
import { emit, load, type Globals } from '../state';

const iso = (at: number | null): string | null =>
	at === null ? null : new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** the one row a console or a terminal shows for a command, with no parameter value in it */
function commandRow(record: CommandRecord) {
	const body = record.envelope.body;
	return {
		id: record.id,
		action: body.action,
		class: record.effectiveClass,
		named: body.class,
		state: record.state,
		outcome: record.result?.outcome ?? null,
		code: record.result?.code ?? null,
		receivedAt: iso(record.receivedAt),
		expiresAt: iso(body.expiresAt)
	};
}

function printFields(): string {
	const { leaves, never } = fieldGroups();
	const lines: string[] = ['what leaves this box, and nothing else:'];
	for (const group of leaves) {
		lines.push('', group.type);
		for (const entry of group.fields) lines.push(`  ${entry.field}  ${entry.description}`);
	}
	lines.push('', 'what never leaves this box:');
	for (const entry of never) lines.push(`  ${entry}`);
	return lines.join('\n');
}

export async function runPair(
	ctx: Context,
	globals: Globals & { showFields?: boolean },
	address: string | undefined
): Promise<void> {
	if (globals.showFields === true) {
		emit(ctx, globals, fieldGroups(), printFields);
		return;
	}
	if (address === undefined || address === '') {
		throw new BastionError(
			'usage',
			'pass the pairing address the dashboard shows, as <url>#<claim token>',
			{ next: 'bastion pair --show-fields' }
		);
	}
	const loaded = load(ctx, globals);
	const record = await claim(
		{
			ctx,
			config: loaded.config,
			state: loaded.state,
			secrets: buildSecrets(ctx, loaded.config.drivers.secrets),
			...(loaded.config.pairing?.sendHostname === true ? { hostname: hostname() } : {})
		},
		address
	);
	emit(ctx, globals, { paired: true, nodeId: record.nodeId, linkUrl: record.linkUrl }, () =>
		[
			`paired as ${record.nodeId}`,
			'`bastion serve` opens the link within a few seconds; it never listens for the dashboard',
			'`bastion pair status` shows the link, and `bastion pair --show-fields` what is sent',
			'`bastion unpair` stops it all and leaves this box working on its own'
		].join('\n')
	);
}

export async function runUnpair(ctx: Context, globals: Globals): Promise<void> {
	const loaded = load(ctx, globals);
	const store = new PairStore(ctx, loaded.state);
	const record = store.record();
	if (record === null) {
		throw new BastionError('not-paired', 'this box is not paired with a control plane', {
			next: 'bastion pair --show-fields'
		});
	}
	store.clear();
	await new NodeKey(buildSecrets(ctx, loaded.config.drivers.secrets)).remove();
	auditPair(ctx, loaded.state, loaded.config.audit, {
		event: 'pair.removed',
		principal: 'operator',
		level: 'warn',
		detail: { nodeId: record.nodeId }
	});
	emit(ctx, globals, { paired: false, nodeId: record.nodeId }, () =>
		[
			`unpaired from ${record.nodeId}`,
			'the node key and every queued command are gone; `bastion serve` closes the link within a second',
			'tenants, sites and configuration were not touched'
		].join('\n')
	);
}

/** what `pair status`, the management API and the console all read */
export function pairingStatus(ctx: Context, globals: Globals) {
	const loaded = load(ctx, globals);
	const store = new PairStore(ctx, loaded.state);
	const record: PairingRecord | null = store.record();
	const fields = fieldGroups();
	if (record === null) return { paired: false as const, fields };
	const link = store.link();
	const commands = store
		.commands()
		.sort((a, b) => b.receivedAt - a.receivedAt)
		.map(commandRow);
	return {
		paired: true as const,
		nodeId: record.nodeId,
		linkUrl: record.linkUrl,
		pairedAt: iso(record.pairedAt),
		link: {
			connected: link.connected,
			connectedAt: iso(link.connectedAt),
			lastMessageAt: iso(link.lastMessageAt),
			lastClose:
				link.lastClose === null ? null : { ...link.lastClose, at: iso(link.lastClose.at) },
			lastRefusal:
				link.lastRefusal === null
					? null
					: { ...link.lastRefusal, at: iso(link.lastRefusal.at) },
			stopped: link.stopped === null ? null : { ...link.stopped, at: iso(link.stopped.at) }
		},
		approvals: (loaded.config.pairing ?? DEFAULT_PAIRING).commands,
		sites: Object.entries(record.siteIds)
			.map(([host, siteId]) => ({ siteId, host }))
			.sort((a, b) => (a.host < b.host ? -1 : 1)),
		commands,
		fields
	};
}

export function runPairStatus(ctx: Context, globals: Globals): void {
	const status = pairingStatus(ctx, globals);
	emit(ctx, globals, status, () => {
		if (!status.paired) {
			return [
				'this box is not paired; it runs on its own and sends nothing',
				'`bastion pair <url>#<claim token>` pairs it, and `bastion pair --show-fields` lists what is sent'
			].join('\n');
		}
		const waiting = status.commands.filter((command) => command.state === 'queued');
		return [
			kv([
				['node', status.nodeId],
				['control plane', status.linkUrl],
				['connected', yesNo(status.link.connected)],
				['last message', status.link.lastMessageAt ?? 'never'],
				['stopped', status.link.stopped?.reason ?? 'no'],
				['waiting', String(waiting.length)]
			]),
			'',
			status.sites.length === 0
				? 'no site ids yet; the dashboard sends them once the link is ready'
				: table(
						['site id', 'host'],
						status.sites.map((site) => [site.siteId, site.host])
					),
			...(status.commands.length === 0
				? []
				: [
						'',
						table(
							['id', 'action', 'class', 'state', 'expires'],
							status.commands.map((command) => [
								command.id,
								command.action,
								command.class,
								command.outcome === null ? command.state : command.outcome,
								command.expiresAt ?? ''
							])
						)
					])
		].join('\n');
	});
}

function decide(ctx: Context, globals: Globals, id: string, decision: 'approve' | 'reject'): void {
	const loaded = load(ctx, globals);
	const store = new PairStore(ctx, loaded.state);
	if (store.record() === null) {
		throw new BastionError('not-paired', 'this box is not paired with a control plane', {
			next: null
		});
	}
	const book = new CommandBook({
		ctx,
		config: loaded.config,
		state: loaded.state,
		executors: fleetExecutors(ctx, globals)
	});
	const record = book.decide(id, decision);
	emit(ctx, globals, { id, decision, action: record.envelope.body.action }, () =>
		[
			`${decision === 'approve' ? 'approved' : 'rejected'} ${id} (${record.envelope.body.action})`,
			'`bastion serve` applies the decision within a second and reports the result'
		].join('\n')
	);
}

export const runPairApprove = (ctx: Context, globals: Globals, id: string): void =>
	decide(ctx, globals, id, 'approve');

export const runPairReject = (ctx: Context, globals: Globals, id: string): void =>
	decide(ctx, globals, id, 'reject');
