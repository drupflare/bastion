import type { BastionConfig } from '../config/types';
import type { Context } from '../context';
import { assertFetchable } from '../deploy/remote';
import { BastionError } from '../errors';
import type { SecretStore } from '../secrets/store';
import { hostFacts, type FieldInput } from './fields';
import { NodeKey, PairStore, auditPair, type PairingRecord } from './store';

/** the token shape the control plane mints: base64url, long enough to be unguessable */
const CLAIM_TOKEN = /^[A-Za-z0-9_-]{22,128}$/;
const NODE_ID = /^nod_[0-9a-z]{8,40}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;

/** the claim route on the control plane's origin */
export const CLAIM_PATH = '/api/v1/nodes/claim';
export const CONTRACT_HEADER = 'Drupflare-Contract';
export const CONTRACT_RANGE = 'fleet-link=1.0-1.0';

export interface ParsedClaim {
	origin: string;
	endpoint: string;
	token: string;
}

/** loopback is the one place plaintext is acceptable: nothing leaves the machine */
export function isLoopbackHost(host: string): boolean {
	const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
	return bare === 'localhost' || bare === '::1' || /^127(\.\d{1,3}){3}$/.test(bare);
}

/**
 * Reads `https://host/p#<claim token>`.
 *
 * The token is in the fragment, which a browser never sends and which this function never puts in
 * a request line, a message or a log. Every refusal below names what is wrong without repeating
 * the input, because the input is a credential.
 */
export function parseClaimUrl(text: string): ParsedClaim {
	let url: URL;
	try {
		url = new URL(text.trim());
	} catch {
		throw new BastionError(
			'usage',
			'that is not a pairing address; copy the whole link from the dashboard',
			{
				next: null
			}
		);
	}
	const loopback = isLoopbackHost(url.hostname);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
		throw new BastionError(
			'pairing-refused',
			url.protocol === 'http:'
				? 'the pairing address is plaintext; the claim token would cross the network unprotected'
				: `pairing uses https, not ${url.protocol.replace(':', '')}`
		);
	}
	if (url.username !== '' || url.password !== '') {
		throw new BastionError(
			'pairing-refused',
			'the pairing address carries a user name or password'
		);
	}
	if (url.search !== '') {
		throw new BastionError(
			'pairing-refused',
			'the pairing address has a query string; the claim token belongs after the #'
		);
	}
	const token = url.hash.replace(/^#/, '');
	if (!CLAIM_TOKEN.test(token)) {
		throw new BastionError(
			'pairing-refused',
			token === ''
				? 'the pairing address has no claim token after the #'
				: 'the claim token after the # is not the shape the dashboard mints'
		);
	}
	return { origin: url.origin, endpoint: `${url.origin}${CLAIM_PATH}`, token };
}

export interface EgressOptions {
	/** how a name becomes addresses; a seam so a spec drives both answers */
	resolve?: (host: string) => Promise<string[]>;
}

/**
 * Refuses a control plane address the box's own egress rules would refuse.
 *
 * A control plane that answers with a link in `169.254.0.0/16` or a private range is asking this
 * box to open a connection into its own network, which is the SSRF the egress policy exists to
 * stop. Loopback is allowed so a control plane can be tried on one machine; that is the only
 * exception, and it applies to the literal loopback names, not to anything that resolves there.
 */
export async function assertReachable(url: string, options: EgressOptions = {}): Promise<void> {
	const parsed = new URL(url);
	const web = new URL(url);
	web.protocol = parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 'https:' : 'http:';
	const loopback = isLoopbackHost(parsed.hostname);
	await assertFetchable(web.toString(), {
		maxBytes: 1,
		insecure: loopback,
		...(options.resolve === undefined ? {} : { resolve: options.resolve })
	});
}

export function assertLink(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new BastionError(
			'pairing-refused',
			'the control plane answered with a link address that is not a url'
		);
	}
	const loopback = isLoopbackHost(parsed.hostname);
	if (parsed.protocol !== 'wss:' && !(parsed.protocol === 'ws:' && loopback)) {
		throw new BastionError(
			'pairing-refused',
			`the control plane's link address uses ${parsed.protocol.replace(':', '')}; the link needs wss`
		);
	}
}

export interface ClaimDeps {
	ctx: Context;
	config: BastionConfig;
	state: string;
	secrets: SecretStore;
	/** `os.hostname()`, passed in so the host name is read only where it may be sent */
	hostname?: string;
	arch?: string;
	resolve?: EgressOptions['resolve'];
}

interface Refusal {
	code?: string;
	message?: string;
	details?: { reason?: string; supported?: unknown };
}

const REFUSAL_TEXT: Record<string, string> = {
	invalid_token: 'the dashboard does not know that claim token; start a new pairing there',
	expired: 'that claim token has expired; they last 15 minutes, so start a new pairing',
	already_claimed: 'that claim token was already used; start a new pairing',
	revoked: 'that pairing was cancelled in the dashboard; start a new one'
};

/**
 * Pairs this box with a control plane.
 *
 * Order matters: the key is made and stored before the request, since the request carries its
 * public half, and it is removed again if the control plane refuses, so a failed claim leaves
 * nothing behind. The host facts sent are exactly the contract's list, and the host name only when
 * the operator's `pairing.sendHostname` allows it.
 */
export async function claim(deps: ClaimDeps, address: string): Promise<PairingRecord> {
	const { ctx, config, state } = deps;
	const store = new PairStore(ctx, state);
	const existing = store.record();
	if (existing !== null) {
		throw new BastionError(
			'pairing-refused',
			`this box is already paired as ${existing.nodeId}`,
			{
				next: 'bastion unpair'
			}
		);
	}

	const parsed = parseClaimUrl(address);
	await assertReachable(parsed.origin, {
		...(deps.resolve === undefined ? {} : { resolve: deps.resolve })
	});

	const keys = new NodeKey(deps.secrets);
	const key = await keys.create();
	const input: FieldInput = {
		ctx,
		config,
		state,
		nodeId: '',
		...(deps.hostname === undefined ? {} : { hostname: deps.hostname }),
		...(deps.arch === undefined ? {} : { arch: deps.arch })
	};

	let response: Response;
	try {
		response = await ctx.fetch(parsed.endpoint, {
			method: 'POST',
			redirect: 'error',
			headers: { 'content-type': 'application/json', [CONTRACT_HEADER]: CONTRACT_RANGE },
			body: JSON.stringify({
				claimToken: parsed.token,
				nodePublicKey: key.publicKey,
				hostFacts: hostFacts(input)
			})
		});
	} catch (error) {
		await keys.remove();
		throw new BastionError(
			'pairing-unreachable',
			`could not reach ${parsed.origin}: ${error instanceof Error ? error.message : 'the request failed'}`
		);
	}

	const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
	if (response.status !== 201 || body === null) {
		await keys.remove();
		const refusal = (body ?? {}) as Refusal;
		const reason = refusal.details?.reason ?? refusal.code ?? '';
		if (response.status === 426) {
			throw new BastionError(
				'pairing-refused',
				'the control plane does not speak a link version this bastion does; update bastion',
				{ next: 'bastion update check' }
			);
		}
		if (response.status >= 500) {
			throw new BastionError(
				'pairing-unreachable',
				`the control plane answered ${response.status}`
			);
		}
		throw new BastionError(
			'pairing-refused',
			REFUSAL_TEXT[reason] ?? `the control plane refused the claim (${response.status})`
		);
	}

	const { nodeId, linkUrl, dashboardPublicKey } = body as Record<string, unknown>;
	if (
		typeof nodeId !== 'string' ||
		!NODE_ID.test(nodeId) ||
		typeof linkUrl !== 'string' ||
		typeof dashboardPublicKey !== 'string' ||
		!PUBLIC_KEY.test(dashboardPublicKey)
	) {
		await keys.remove();
		throw new BastionError(
			'pairing-refused',
			'the control plane answered with a reply this bastion does not understand'
		);
	}
	try {
		assertLink(linkUrl);
		await assertReachable(linkUrl, deps.resolve === undefined ? {} : { resolve: deps.resolve });
	} catch (error) {
		await keys.remove();
		throw error;
	}

	const record: PairingRecord = {
		nodeId,
		linkUrl,
		dashboardPublicKey,
		nodePublicKey: key.publicKey,
		pairedAt: ctx.now(),
		siteIds: {}
	};
	store.save(record);
	auditPair(ctx, state, config.audit, {
		event: 'pair.claimed',
		principal: 'operator',
		level: 'warn',
		detail: { nodeId, origin: parsed.origin }
	});
	return record;
}
