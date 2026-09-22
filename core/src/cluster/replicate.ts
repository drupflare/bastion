import type { Context } from '../context';
import { BastionError } from '../errors';
import { CLUSTER_PATHS, CLUSTER_PROTOCOL } from './protocol';

export type ReplicaAction = 'provision' | 'snapshot' | 'status' | 'withdraw';

export interface ReplicaRequest {
	site: string;
	lane: number;
	action: ReplicaAction;
}

export interface ReplicaResult {
	ok: boolean;
	action: ReplicaAction;
	stage: string;
	detail: string;
}

/**
 * The node-to-node `/replica` driver.
 *
 * drangler refuses to let its CLI touch `/replica`, and that refusal stands: within one Cloudflare
 * account a lane that withdrew asks the primary for a fresh copy itself, the primary queues it and
 * arms an alarm, and there is nothing for an operator to drive.
 *
 * **That self-healing depends on the lane being able to reach the primary, which is `idFromName`
 * inside one account.** Across a node boundary it does not exist, so the mechanism that made the
 * route operator-free is simply absent here. bastion is the plane rather than an operator, so it
 * supplies the transport.
 */
export class ReplicaDriver {
	private readonly ctx: Context;
	private readonly ownerToken: string;
	private readonly credential: string;

	/**
	 * @param ownerToken the SITE's own token, which its `/replica` route checks
	 * @param credential this NODE's cluster credential, which the endpoint in front of it checks
	 */
	constructor(ctx: Context, ownerToken: string, credential = '') {
		this.ctx = ctx;
		this.ownerToken = ownerToken;
		this.credential = credential;
	}

	/**
	 * Reaches a node's site `/replica` route through its cluster endpoint.
	 *
	 * Not through the front door, which refuses the whole diagnostic set including `/replica` for
	 * every tenant. Going around that refusal for node traffic would mean opening it for site
	 * traffic too; the cluster endpoint is the authenticated way in, and it takes a node credential
	 * rather than an operator one.
	 */
	private async call(nodeAddress: string, request: ReplicaRequest): Promise<ReplicaResult> {
		const response = await this.ctx.fetch(`http://${nodeAddress}${CLUSTER_PATHS.replica}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${this.credential}`
			},
			body: JSON.stringify({
				protocol: CLUSTER_PROTOCOL,
				site: request.site,
				action: request.action,
				lane: request.lane,
				ownerToken: this.ownerToken
			})
		});
		const body = (await response.json().catch(() => ({}))) as {
			result?: { ok?: boolean; detail?: string };
			error?: { message?: string };
		};
		return {
			ok: response.ok && body.result?.ok !== false,
			action: request.action,
			stage: response.ok ? 'ok' : 'failed',
			detail: String(body.result?.detail ?? body.error?.message ?? response.status)
		};
	}

	/**
	 * Brings a replica node into service.
	 *
	 * **A form-bearing page is rendered FIRST and the key verified.** Drupal creates
	 * `state:system.private_key` lazily, on the first page carrying a CSRF token, and no lane is
	 * admitted until one exists -- so a freshly migrated site with none sits at `CREATED` forever and
	 * reads as "the cluster will not scale". It was measured at forty provision steps refusing, then
	 * one succeeding once a single `/user/login` had rendered. Provisioning first and reporting a
	 * stage is what made that look like a capacity limit instead of a missing key.
	 */
	async join(
		primaryAddress: string,
		replicaAddress: string,
		site: string,
		lane: number
	): Promise<ReplicaResult[]> {
		const steps: ReplicaResult[] = [];
		const primed = await this.primeKey(primaryAddress, site);
		steps.push(primed);
		if (!primed.ok) return steps;

		steps.push(await this.call(primaryAddress, { site, lane, action: 'snapshot' }));
		steps.push(await this.call(replicaAddress, { site, lane, action: 'provision' }));
		return steps;
	}

	/** renders a page carrying a CSRF token, which is what mints the key a replica needs */
	async primeKey(primaryAddress: string, site: string): Promise<ReplicaResult> {
		const response = await this.ctx.fetch(`http://${primaryAddress}/user/login`, {
			headers: { host: site }
		});
		const body = await response.text().catch(() => '');
		const minted = response.ok && /form_build_id|csrf|form_token/i.test(body);
		return {
			ok: minted,
			action: 'provision',
			stage: minted ? 'key-present' : 'key-missing',
			detail: minted
				? 'a form-bearing page rendered, so state:system.private_key exists'
				: 'no form-bearing page rendered, so the private key has not been minted yet and ' +
					'every replica would refuse for that reason rather than for a capacity one'
		};
	}

	async snapshot(primaryAddress: string, site: string, lane: number): Promise<ReplicaResult> {
		return this.call(primaryAddress, { site, lane, action: 'snapshot' });
	}

	async status(address: string, site: string, lane: number): Promise<ReplicaResult> {
		return this.call(address, { site, lane, action: 'status' });
	}
}

/**
 * The Host every node forwards, which must be byte-identical across the cluster.
 *
 * Drupal derives its session cookie name from `$request->getHost()`, so a replica that first saw a
 * different host looks for a cookie no browser sends and renders every visitor anonymous --
 * deterministically, regardless of replication. A rig's `arm.invalid` host caused exactly that, and
 * the pool served 0% of authenticated traffic for weeks with every gate spec passing.
 */
export function sessionCookieName(host: string): string {
	// Drupal's rule: SESS + md5-ish of the host. The exact digest is Drupal's; what bastion asserts
	// is that two nodes deriving it from the same forwarded Host get the same answer
	let hash = 0x811c9dc5;
	for (const char of host.toLowerCase()) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `SESS${hash.toString(16).padStart(8, '0')}`;
}

export function assertSameCookieName(hostA: string, hostB: string): void {
	if (sessionCookieName(hostA) !== sessionCookieName(hostB)) {
		throw new BastionError(
			'health-finding',
			`two nodes are forwarding different hosts (${hostA} against ${hostB}), so they derive ` +
				'different session cookie names and one of them renders every visitor anonymous'
		);
	}
}
