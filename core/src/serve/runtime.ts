import { createHash } from 'node:crypto';
import { buildAdapters, type AdapterClients, type AdapterInput } from '../adapters/build';
import { ADAPTER_SLOTS, handleSlot, type AdapterSet } from '../adapters/server';
import { handleApi, type ApiDeps, type ApiHandler } from '../api/server';
import { renderConfig, type CapnpConfig } from '../capnp/generate';
import { modulesFrom, planSite, socketFor } from '../capnp/plan';
import { handleCluster } from '../cluster/control';
import { NodeCredentials } from '../cluster/credentials';
import { forward, forwardTarget, type ForwardTarget } from '../cluster/forward';
import { MembershipStore } from '../cluster/membership';
import { PlacementStore, type Placement } from '../cluster/placement';
import { CLUSTER_PREFIX, type ReplicaRequest } from '../cluster/protocol';
import { NodeRegistry, type ClusterNode } from '../cluster/registry';
import {
	DEFAULT_CAPABILITIES,
	DEFAULT_COMPATIBILITY_DATE,
	DEFAULT_COMPATIBILITY_FLAGS,
	resolveSiteWorker
} from '../config/defaults';
import { loadConfig } from '../config/file';
import type { BastionConfig, SiteConfig, TenantConfig } from '../config/types';
import type { Context } from '../context';
import { BastionError } from '../errors';
import { buildFront, listenerSpec } from '../front/door';
import { handleRequest, type FrontDeps } from '../front/handler';
import type { Listener, ListenerHost, TlsMaterial } from '../front/listener';
import { swapListener } from '../front/listener';
import type { Route } from '../front/router';
import { TENANT_SOCKET } from '../front/upstream';
import { HealthLedger } from '../health/ledger';
import { sweep, type HealthInput } from '../health/probes';
import type { Finding } from '../health/tripwires';
import { applyCgroup, attachPid } from '../isolation/cgroups';
import { assertModeSafe } from '../isolation/modes';
import { modeAvailable, preflight } from '../isolation/preflight';
import {
	createNetns,
	installApparmorProfile,
	sandboxArgv,
	type SandboxPaths
} from '../isolation/sandbox';
import { AnalyticsWindow, DataPointWindow } from '../observe/analytics';
import { TenantSupervisor } from '../supervise/tenant';
import { ACME_CHALLENGE_PREFIX, httpResponder } from '../tls/acme';
import { CertificateStore } from '../tls/store';
import { nonce, securityHeaders } from './security';
import { serveStatic, type AssetBundle } from './static';

export interface RuntimeOptions {
	config: BastionConfig;
	host: ListenerHost;
	/** proxies a sanitised request to the tenant's workerd over its unix socket */
	upstream(route: Route, request: Request, client: string): Promise<Response>;
	api?: Record<string, ApiHandler>;
	/** the built dashboard, served from memory; an empty bundle answers with a page saying so */
	dashboard?: AssetBundle;
	/** the placement table, on the control node; a child reads its own from the membership file */
	placement?: Placement[];
	/** the nodes a forward can dial, likewise */
	nodes?: ClusterNode[];
	sessions?: ApiDeps['sessions'];
	tokens?: ApiDeps['tokens'];
	/** the resolved workerd binary; absent means do not start tenants */
	binary?: string;
	acknowledgeUnsafeMode?: boolean;
	/** a seam so the gate lane drives both sides of the platform refusal */
	platform?: string;
	/** clients and transports bastion refuses to pick a library for, handed to the adapters */
	clients?: AdapterClients;
	/**
	 * Builds one tenant's adapters, defaulting to the configured drivers.
	 *
	 * A seam rather than an option the caller must remember: leaving it out gets the real builder,
	 * so nothing can start a tenant whose bindings have nothing behind them. The gate lane
	 * substitutes it because a driver opens a real sqlite file and a real socket.
	 */
	adapters?: (ctx: Context, input: AdapterInput) => AdapterSet;
	/**
	 * Where the configuration came from, so a reload can read it again.
	 *
	 * Without this the running process compares the config it loaded at STARTUP against the digest
	 * it recorded from that same config, finds them equal, and swaps nothing: `bastion reload` after
	 * raising a memory limit reported `0 tenants swapped` and left the old limit in place. The CLI
	 * edits the file; the process holding the tenants has to go back to it.
	 */
	configPath?: string;
}

/**
 * Where a tenant records the workerd that is serving it right now.
 *
 * `status` runs in a different process from `serve` and has no handle on the supervisor, and the
 * unix socket file survives the process that bound it, so a killed tenant read as `up` from a box
 * that was itself still running. A pid can be signalled.
 */
export const RUNTIME_PIDFILE = 'workerd.pid';

/** how long `startTenant` waits for the loop's first spawn before returning anyway */
const SPAWN_WAIT_MS = 2000;
const SPAWN_POLL_MS = 10;

/** what a tenant is running with, so `reload` compares against the box rather than against nothing */
export const RUNTIME_DIGEST = 'config.sha256';

/**
 * How `bastion reload` reaches the process that holds the tenants.
 *
 * A file rather than a signal or the management API, for the reasons the rest of this state
 * directory already works that way: a signal carries no payload and cannot say which tenants, and
 * the management API needs a credential and a listener that may be the thing that is broken. The
 * CLI writes the request, `serve` performs the swap and writes the outcome beside it, and the CLI
 * reads that back. Both files are inside `state`, so the filesystem permissions on the state
 * directory are the access control.
 */
export const RELOAD_REQUEST = 'reload.request';
export const RELOAD_OUTCOME = 'reload.outcome';

export interface ReloadOutcome {
	at: number;
	swapped: string[];
	failed: { tenant: string; reason: string }[];
}

/**
 * A digest of everything that decides one tenant's generated configuration.
 *
 * Exported so the runtime that writes it and the command that reads it cannot compute it
 * differently. `reload` used to own this alone and nothing recorded a baseline, so the first run on
 * any box reported every tenant as changed: the answer depended on whether `reload` had been run
 * before rather than on whether anything moved.
 */
export function tenantDigest(config: BastionConfig, tenant: TenantConfig): string {
	return createHash('sha256')
		.update(JSON.stringify({ tenant, runtime: config.runtime, mode: config.mode }))
		.digest('hex');
}

export interface RuntimeState {
	mode: BastionConfig['mode'];
	tenants: string[];
	listeners: { which: string; address: string }[];
	warnings: string[];
}

/**
 * Everything `bastion serve` drives, in one place.
 *
 * The parts are individually testable and this is what wires them together, so a spec can assert
 * the ORDER as well as the pieces. Order matters more than it looks: the mode refusal runs before
 * any tenant starts, because a box that came up and then refused would already have served requests
 * under the weaker boundary; the cgroup is created before the process so the pid can be attached
 * the moment it exists; and the listeners bind last so nothing is reachable before the tenants
 * behind them are up.
 */
export class Runtime {
	private readonly ctx: Context;
	private options: RuntimeOptions;
	private readonly supervisors = new Map<string, TenantSupervisor>();
	private readonly listeners = new Map<string, Listener>();
	/** one unix listener per adapter slot, per tenant, torn down with the tenant */
	private readonly adapters = new Map<string, Listener[]>();
	private readonly challenges = httpResponder();
	private front: FrontDeps | null = null;
	/** every served request lands here, which is what the analytics view reads */
	readonly analytics = new AnalyticsWindow();
	/** the findings file this box writes, which `bastion health` reads from another process */
	readonly ledger: HealthLedger;
	private readonly startedAt: number;
	/** what a tenant's own Analytics Engine binding writes, which is a different record entirely */
	readonly dataPoints = new DataPointWindow();
	/**
	 * Refusals that never reached a site, counted by reason.
	 *
	 * A per-IP rate limit and an unknown host are both decided BEFORE routing, so there is no
	 * tenant to attribute them to and they would otherwise be invisible. A flood of either is
	 * exactly what an operator needs to see, so they are counted here rather than dropped.
	 */
	readonly unattributed = new Map<string, number>();

	constructor(ctx: Context, options: RuntimeOptions) {
		this.ctx = ctx;
		this.options = options;
		this.ledger = new HealthLedger(ctx, options.config.state);
		this.startedAt = ctx.now();
	}

	/**
	 * Supplies the management handlers after construction.
	 *
	 * They are attached rather than passed in because several of them read this runtime's own
	 * state, and a handler map that closes over the runtime cannot be built before it exists.
	 */
	attachApi(
		handlers: Record<string, ApiHandler>,
		deps?: Pick<RuntimeOptions, 'sessions' | 'tokens' | 'dashboard'>
	): void {
		this.options = { ...this.options, api: handlers, ...deps };
	}

	get challengeResponder() {
		return this.challenges;
	}

	/** refuses before anything binds, and returns what an operator should be told */
	preflight(): { mode: BastionConfig['mode']; warnings: string[] } {
		const config = this.options.config;
		const mode = config.mode;
		const report = preflight(this.ctx, this.options.platform);
		const availability = modeAvailable(report, mode);
		if (!availability.ok) {
			throw new BastionError('preflight-unsupported', availability.message, {
				next: 'bastion doctor'
			});
		}
		const safety = assertModeSafe(
			mode,
			config.tenants.length,
			this.options.acknowledgeUnsafeMode === true
		);
		return { mode, warnings: safety.warned ? [safety.warning] : [] };
	}

	private pathsFor(tenant: string): SandboxPaths {
		const state = `${this.options.config.state}/tenants/${tenant}`;
		return {
			state,
			config: `${state}/config.capnp`,
			netns: `bastion-${tenant}`,
			apparmorProfile: `bastion-tenant-${tenant}`,
			cgroup: `/sys/fs/cgroup/bastion.slice/tenant-${tenant}`
		};
	}

	/**
	 * Where the modules for this site actually are.
	 *
	 * `site.bundle` is what the operator typed and is the only thing that knows where the code is.
	 * An earlier version read `${state}/tenants/<name>/bundle` unconditionally, which nothing ever
	 * writes, so every `up` spawned a child that died on `ENOENT` while the parent reported a pid.
	 *
	 * A directory is used where it stands. An archive is extracted once into the tenant's state,
	 * because workerd reads modules off disk and cannot be handed a tarball.
	 */
	private bundleFor(site: SiteConfig, paths: SandboxPaths): string {
		const stated = site.bundle.startsWith('/')
			? site.bundle
			: `${this.ctx.cwd}/${site.bundle.replace(/^\.\//, '')}`;

		if (this.ctx.files.isDirectory(stated)) return stated;
		if (!this.ctx.files.exists(stated)) {
			throw new BastionError('usage', `${site.host} has no bundle at ${stated}`, {
				next: 'bastion site show'
			});
		}

		const extracted = `${paths.state}/bundle`;
		this.ctx.files.mkdirp(extracted);
		void this.ctx.runner.run('tar', ['-xzf', stated, '-C', extracted]);
		return extracted;
	}

	/**
	 * Writes the `config.capnp` the supervisor is about to point workerd at.
	 *
	 * The supervisor took this path as an input from the start and nothing ever produced the file,
	 * so `up` spawned workerd against a path that did not exist. Generating it here is what makes
	 * the declarative config the thing that actually runs, for any bundle rather than one shape.
	 */
	private writeCapnp(tenant: TenantConfig, paths: SandboxPaths): CapnpConfig | null {
		const config = this.options.config;
		const site = tenant.sites[0];
		if (site === undefined) return null;

		const worker = resolveSiteWorker(site.worker);
		const bundle = this.bundleFor(site, paths);

		// workerd refuses a `disk` service whose directory is absent, and its own storage is one:
		// `Directory named "bastion_storage" not found`. It creates neither, so bastion does
		for (const dir of ['storage', 'assets', 'adapters']) {
			this.ctx.files.mkdirp(`${paths.state}/${dir}`);
		}

		// a unix socket outlives the process that bound it and workerd answers `Address already in
		// use` rather than replacing it, so an unclean stop blocks every later start
		this.ctx.files.remove(`${paths.state}/${TENANT_SOCKET}`);
		for (const slot of ADAPTER_SLOTS) {
			this.ctx.files.remove(socketFor({ adapterDir: `${paths.state}/adapters` }, slot));
		}

		const plan = planSite({
			tenant,
			site,
			paths: {
				bundle,
				storage: `${paths.state}/storage`,
				assets: `${paths.state}/assets`,
				adapterDir: `${paths.state}/adapters`,
				listenSocket: `${paths.state}/${TENANT_SOCKET}`
			},
			// the embeds resolve against the capnp's own directory, which is the tenant state dir
			modules: modulesFrom(this.ctx, bundle, worker.main, paths.state),
			compatibilityDate: worker.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
			compatibilityFlags: worker.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS,
			uniqueKey: `${tenant.name}:${site.host}`,
			durableObjectClass: worker.durableObjectClass ?? undefined,
			residency: config.runtime.residency,
			// every slot the site declared, not the five this once carried: a `worker` block naming
			// a d1 or an ai binding validated, generated nothing, and the bundle found the binding
			// missing at runtime
			bindings: {
				durableObject: worker.durableObject,
				assets: worker.assets,
				kv: worker.kv,
				r2: worker.r2,
				queues: worker.queues,
				d1: worker.d1,
				vectorize: worker.vectorize,
				ai: worker.ai,
				images: worker.images,
				email: worker.email,
				analytics: worker.analytics,
				browser: worker.browser,
				hyperdrive: worker.hyperdrive,
				...(worker.versionMetadata === undefined
					? {}
					: { versionMetadata: worker.versionMetadata })
			},
			vars: site.bindings ?? {}
		});
		this.ctx.files.writeText(paths.config, renderConfig(plan));
		return plan;
	}

	/**
	 * Binds one unix socket per adapter the tenant's generated config names.
	 *
	 * **The plan decides, not a list kept alongside it.** Every `external` service in the capnp is
	 * an address workerd will dial, so walking the plan is what makes a binding bastion emits and a
	 * socket bastion serves the same set by construction. They were not: the generator wrote the
	 * addresses, nothing ever bound them, and a bundle using KV, D1, the Cache API or any other
	 * adapter met a connection error on its first call while a worker with no bindings served fine.
	 */
	private async bindAdapters(tenant: TenantConfig, paths: SandboxPaths, plan: CapnpConfig) {
		const build = this.options.adapters ?? buildAdapters;
		const set = build(this.ctx, {
			config: this.options.config,
			tenant,
			state: paths.state,
			analytics: this.dataPoints,
			...(tenant.sites[0] === undefined ? {} : { site: tenant.sites[0] }),
			...(this.options.clients === undefined ? {} : { clients: this.options.clients })
		});

		const bound: Listener[] = [];
		for (const service of plan.services) {
			if (service.kind !== 'external') continue;
			if (!service.address.startsWith('unix:')) continue;
			const slot = service.name.replace(/^bastion_/, '');
			bound.push(
				this.options.host.listen(
					{ address: '', unix: service.address.slice('unix:'.length) },
					(request) => handleSlot(set, slot, request, new URL(request.url).pathname)
				)
			);
		}
		this.adapters.set(tenant.name, bound);
		return set;
	}

	/**
	 * Brings one tenant up with its wall around it.
	 *
	 * The cgroup exists before the process so `attachPid` has somewhere to write the moment the
	 * process does. A cgroup created after the spawn is a window in which the tenant is unbounded,
	 * and the window is exactly the startup burst that a memory limit is there to catch.
	 */
	async startTenant(tenant: string): Promise<TenantSupervisor> {
		const config = this.options.config;
		const binary = this.options.binary;
		if (binary === undefined)
			throw new BastionError('workerd-missing', 'no workerd binary resolved');

		const declared = config.tenants.find((entry) => entry.name === tenant);
		if (declared === undefined) throw new BastionError('usage', `no tenant called ${tenant}`);

		const paths = this.pathsFor(tenant);
		this.ctx.files.mkdirp(paths.state);
		const plan = this.writeCapnp(declared, paths);
		// the sockets are bound BEFORE workerd starts; a tenant that beats its own adapters up
		// answers the first request out of an error path rather than out of its cache
		if (plan !== null) await this.bindAdapters(declared, paths, plan);
		applyCgroup(this.ctx, tenant, declared.limits ?? {});

		if (config.mode === 'hardened') {
			await createNetns(this.ctx, tenant);
			await installApparmorProfile(this.ctx, tenant, paths, binary);
		}

		const wrapped = sandboxArgv({ mode: config.mode, tenant, paths }, binary, []);
		const supervisor = new TenantSupervisor(this.ctx, tenant, {
			binary: wrapped.command,
			configPath: paths.config,
			// the dead process still holds its socket name and workerd refuses to bind over one;
			// only this tenant's own, since the adapter sockets beside it are bastion's and live
			beforeStart: () => this.ctx.files.remove(`${paths.state}/${TENANT_SOCKET}`),
			// every start, not the first: a restart that skipped this would bring the tenant back
			// with no cgroup, which is worst exactly when the kill was an OOM
			onStart: (pid) => {
				attachPid(this.ctx, tenant, pid);
				this.ctx.files.writeText(`${paths.state}/${RUNTIME_PIDFILE}`, String(pid));
				// the configuration this process is actually running with, which is what `reload`
				// has to compare against
				this.ctx.files.writeText(
					`${paths.state}/${RUNTIME_DIGEST}`,
					`${tenantDigest(config, declared)}\n`
				);
			}
		});
		this.supervisors.set(tenant, supervisor);

		// `run` rather than `start`: it is the loop, and nothing called it. The supervisor had a
		// backoff, a jitter and a crash-loop breaker, and a tenant whose workerd died stayed dead
		// with every request answering 502 while `status` still read the box as running. Not
		// awaited, because it resolves only when the tenant is stopped or quarantined
		void supervisor.run().then((state) => {
			if (state === 'quarantined') {
				this.ctx.io.err(`tenant ${tenant} is quarantined; run \`bastion repair\``);
			}
			this.ctx.files.remove(`${paths.state}/${RUNTIME_PIDFILE}`);
		});
		await this.started(supervisor);
		return supervisor;
	}

	/**
	 * Waits for the supervisor's first spawn, which `run` does asynchronously.
	 *
	 * `start` returned the process, so a caller had it the moment `startTenant` resolved. The loop
	 * spawns inside its own promise, so `up` would otherwise report a tenant before its pid exists
	 * and the cgroup assertions would race it.
	 */
	private async started(supervisor: TenantSupervisor): Promise<void> {
		for (let waited = 0; waited < SPAWN_WAIT_MS; waited += SPAWN_POLL_MS) {
			if (supervisor.snapshot().pid !== null) return;
			await new Promise((resolve) => setTimeout(resolve, SPAWN_POLL_MS));
		}
	}

	/**
	 * The request the front door answers.
	 *
	 * ACME's http-01 challenge is served here rather than by a second listener, because the front
	 * door is already the only thing on port 80 and a file left under a web root is one more thing
	 * to clean up correctly.
	 */
	async serve(request: Request, peer: string): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith(ACME_CHALLENGE_PREFIX)) {
			const token = url.pathname.slice(ACME_CHALLENGE_PREFIX.length);
			const answer = this.challenges.answer(token);
			return answer === null
				? new Response('not found', { status: 404 })
				: new Response(answer, { headers: { 'content-type': 'text/plain' } });
		}
		if (this.front === null) {
			this.front = buildFront(this.ctx, this.options.config, {
				upstream: this.options.upstream,
				hsts: this.options.config.listeners.https !== undefined
			});
		}

		// a site this node does not hold is answered by the node that does, before the front door
		// spends anything on a request it cannot serve
		const elsewhere = this.forwardFor(request);
		if (elsewhere !== null) {
			return forward(this.ctx, elsewhere, request, this.nodeId);
		}

		const startedAt = this.ctx.now();
		const outcome = await handleRequest(request, peer, this.front);

		// the outcome already carries the route, the client and the refusal reason, and every one
		// of them used to be discarded here. Recording costs one push and is the difference
		// between an analytics view and an empty one
		if (outcome.route === null && outcome.refusal !== null) {
			this.unattributed.set(
				outcome.refusal,
				(this.unattributed.get(outcome.refusal) ?? 0) + 1
			);
		}
		if (outcome.route !== null) {
			const length = outcome.response.headers.get('content-length');
			this.analytics.record({
				at: startedAt,
				tenant: outcome.route.tenant,
				site: outcome.route.site,
				status: outcome.response.status,
				durationMs: Math.max(0, this.ctx.now() - startedAt),
				bytes: length === null ? 0 : Number(length),
				cached: outcome.response.headers.get('cf-cache-status') === 'HIT',
				refusal: outcome.refusal
			});
		}
		return outcome.response;
	}

	/** this node's id, which is what a forward stamps on a request so it is not forwarded twice */
	get nodeId(): string {
		return this.options.config.cluster?.node.id ?? 'local';
	}

	/**
	 * The node that should answer this request, or null to answer it here.
	 *
	 * Reads the placement table off disk rather than asking the control node, so a partitioned
	 * node keeps serving what it already holds. A node in no cluster has no membership file and
	 * every request is local, which is the single-node case costing one `exists` check.
	 */
	private forwardFor(request: Request): ForwardTarget | null {
		const cluster = this.options.config.cluster;
		if (cluster === undefined) return null;
		const state = this.options.config.state;
		const control = cluster.role === 'control';
		const held = control ? null : new MembershipStore(this.ctx, state).read();
		const placement = control
			? new PlacementStore(this.ctx, state).all()
			: (held?.placement ?? this.options.placement ?? []);
		const nodes = control
			? new NodeRegistry(this.ctx, state).list()
			: (held?.nodes ?? this.options.nodes ?? []);
		if (placement.length === 0 || nodes.length === 0) return null;

		const site = (request.headers.get('host') ?? '').split(':')[0] ?? '';
		return forwardTarget({
			request,
			site,
			localNode: this.nodeId,
			placement,
			nodes
		});
	}

	/**
	 * Drives a local site's `/replica` route for a peer that holds a node credential.
	 *
	 * Straight to the tenant's workerd rather than through the front door, because the front door
	 * refuses the whole diagnostic set including `/replica` and that refusal is what keeps a
	 * compromised site from reaching it. This is the authenticated way past it, and the credential
	 * has already been checked by the time this runs.
	 */
	private async driveReplica(
		ask: ReplicaRequest,
		from: string
	): Promise<{ ok: boolean; detail: string }> {
		const tenant = this.options.config.tenants.find((entry) =>
			entry.sites.some((site) => site.host === ask.site)
		);
		if (tenant === undefined) {
			return { ok: false, detail: `this node holds no site called ${ask.site}` };
		}
		const url = new URL(`http://${ask.site}/replica`);
		url.searchParams.set('action', ask.action);
		if (ask.lane !== undefined) url.searchParams.set('lane', String(ask.lane));
		// the site's own token, which its route checks; the node credential got the caller this
		// far and says nothing to the worker about who owns the site
		const owner = (ask as { ownerToken?: string }).ownerToken ?? '';

		const route: Route = {
			host: ask.site,
			tenant: tenant.name,
			site: ask.site,
			capabilities: { ...DEFAULT_CAPABILITIES, ...(tenant.capabilities ?? {}) },
			primary: null,
			replicas: [],
			names: [ask.site],
			canonical: null,
			forceHttps: false
		};
		try {
			const answer = await this.options.upstream(
				route,
				new Request(url, {
					method: 'POST',
					headers: { host: ask.site, 'x-cfw-owner-token': owner }
				}),
				from
			);
			return {
				ok: answer.ok,
				detail: `${answer.status} ${await answer.text()}`.slice(0, 500)
			};
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		}
	}

	/** the management listener, which is a different origin from every tenant's site */
	async serveManagement(request: Request): Promise<Response> {
		const { sessions, tokens } = this.options;
		const url = new URL(request.url);

		// node to node, on the same port and a different prefix. Checked before the api, because a
		// node credential must never reach the operator authz table
		if (url.pathname.startsWith(CLUSTER_PREFIX)) {
			const state = this.options.config.state;
			const answered = await handleCluster(this.ctx, request, {
				config: this.options.config,
				registry: new NodeRegistry(this.ctx, state),
				credentials: new NodeCredentials(this.ctx, state),
				placement: () => new PlacementStore(this.ctx, state).all(),
				replica: (ask, from) => this.driveReplica(ask, from)
			});
			if (answered !== null) return answered;
		}

		// the app itself is unauthenticated, because the sign-in screen has to render before there
		// is a session to check. Nothing here carries data; the api behind it is the boundary
		if (!url.pathname.startsWith('/api/') && request.method === 'GET') {
			const scriptNonce = nonce();
			const page = serveStatic(this.options.dashboard ?? {}, url.pathname, {
				nonce: scriptNonce,
				headers: {
					...securityHeaders(scriptNonce, url.protocol === 'https:'),
					'x-bastion-nonce': scriptNonce
				}
			});
			if (page !== null) return page;
		}

		if (sessions === undefined || tokens === undefined) {
			return new Response('the management API is not configured', { status: 503 });
		}
		return handleApi(this.ctx, request, {
			config: this.options.config,
			sessions,
			tokens,
			origin: `http://${this.options.config.listeners.management.address}`,
			handlers: this.options.api ?? {}
		});
	}

	/** binds or rebinds a listener; a cert change comes through here rather than through a reload */
	async bind(which: 'http' | 'https' | 'management', tls?: TlsMaterial[]): Promise<Listener> {
		const spec = listenerSpec(this.options.config, which, tls);
		const next = await swapListener(
			this.options.host,
			this.listeners.get(which) ?? null,
			spec,
			which === 'management'
				? (request) => this.serveManagement(request)
				: (request, peer) => this.serve(request, peer)
		);
		this.listeners.set(which, next);
		return next;
	}

	/**
	 * Brings up the console and its API.
	 *
	 * **Plaintext is allowed on loopback and refused anywhere else.** The session cookie carries
	 * the `__Host-` prefix, which a browser only accepts over TLS, so a plaintext listener serves
	 * the app and answers a bearer token and cannot be signed into. That is a usable first run and
	 * a warning, rather than a box that refuses to start because its console has no certificate;
	 * on any other address it is a console exposed in cleartext, which is not.
	 */
	private async bindManagement(): Promise<{ listener: Listener; warnings: string[] }> {
		const address = this.options.config.listeners.management?.address ?? '127.0.0.1:8787';
		const host = address.slice(0, address.lastIndexOf(':'));
		const material = this.material().filter((entry) => entry.serverName === host);
		if (material.length > 0) {
			return { listener: await this.bind('management', material), warnings: [] };
		}

		const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
		const clustered = this.options.config.cluster !== undefined;
		if (!loopback && !clustered) {
			throw new BastionError(
				'config-invalid',
				`the management listener is on ${address} with no certificate for ${host}, and ` +
					'binding it would serve the console in cleartext off this machine',
				{ next: `bastion cert self-sign ${host}` }
			);
		}
		if (!loopback) {
			// a cluster needs this listener reachable by construction: a child dials it. What that
			// costs is stated rather than refused, because refusing would make a cluster
			// unbuildable, and the cost is real -- a join token and a node credential cross it
			return {
				listener: await this.bind('management'),
				warnings: [
					`the cluster wire on ${address} has no certificate, so node-to-node traffic is ` +
						'plaintext and carries a bearer credential. Put the cluster on a private ' +
						`network, or issue a certificate with \`bastion cert self-sign ${host}\`.`
				]
			};
		}
		return {
			listener: await this.bind('management'),
			warnings: [
				`the console on ${address} has no certificate, so it serves plaintext on loopback. ` +
					'The API answers a token, and browser sign-in needs tls because the session ' +
					`cookie is __Host- prefixed. Run \`bastion cert self-sign ${host}\` to fix it.`
			]
		};
	}

	/** the SNI table, rebuilt from the certificate store so a renewal is a rebind */
	material(): TlsMaterial[] {
		return new CertificateStore(this.ctx, `${this.options.config.state}/certs`).material();
	}

	/**
	 * Starts every tenant, then binds the listeners in front of them.
	 *
	 * A failure after a tenant has started takes every tenant back down with it. Tenants start
	 * first so nothing is reachable before what serves it is up, which means a later refusal has
	 * already spawned processes; leaving them running holds the unix socket, so the parent cannot
	 * exit and the next `up` meets `Address already in use`.
	 */
	async up(): Promise<RuntimeState> {
		const { mode, warnings } = this.preflight();
		for (const tenant of this.options.config.tenants) {
			if (this.options.binary === undefined) break;
			await this.startTenant(tenant.name);
		}

		try {
			const bound: { which: string; address: string }[] = [];
			if (this.options.config.listeners.http !== undefined) {
				const listener = await this.bind('http');
				bound.push({ which: 'http', address: `${listener.hostname}:${listener.port}` });
			}
			if (this.options.config.listeners.https !== undefined) {
				// an https listener with no keypair binds PLAINTEXT and still calls itself https,
				// so the port that exists to encrypt serves cleartext and the operator is told it
				const material = this.material();
				if (material.length === 0) {
					throw new BastionError(
						'config-invalid',
						'the https listener has no certificate, and binding it without one would ' +
							'serve plaintext on the port that exists to encrypt',
						{ next: 'bastion cert issue' }
					);
				}
				const listener = await this.bind('https', material);
				bound.push({ which: 'https', address: `${listener.hostname}:${listener.port}` });
			}

			// the console and its api, which nothing bound for as long as they existed: `status`
			// printed the configured address and no process was listening on it
			const management = await this.bindManagement();
			bound.push({
				which: 'management',
				address: `${management.listener.hostname}:${management.listener.port}`
			});

			return {
				mode,
				tenants: [...this.supervisors.keys()],
				listeners: bound,
				warnings: [...warnings, ...management.warnings]
			};
		} catch (error) {
			await this.down();
			throw error;
		}
	}

	/**
	 * Stops one tenant and starts it again on the configuration now on disk.
	 *
	 * The unit is the tenant because workerd has no in-place reload: `--watch` re-executes the
	 * binary over itself and loses every in-memory Durable Object, so a swap is a process swap
	 * whatever it is called. What this buys over `restart` is the blast radius: the tenants that did
	 * not change keep their objects resident, which on a box holding a department's sites is the
	 * difference between one site blinking and all of them.
	 *
	 * Sequential rather than concurrent: two tenants swapping at once double the memory high-water
	 * mark for no gain, and the whole point is to disturb as little as possible.
	 */
	async swapTenant(tenant: string): Promise<void> {
		const supervisor = this.supervisors.get(tenant);
		if (supervisor !== undefined) {
			supervisor.stop();
			for (const listener of this.adapters.get(tenant) ?? []) await listener.stop(false);
			this.adapters.delete(tenant);
			this.supervisors.delete(tenant);
		}
		// the capnp is regenerated from the config on disk, which is what makes this a swap rather
		// than a restart of the same thing
		await this.startTenant(tenant);
	}

	/**
	 * Swaps every tenant whose configuration no longer matches what it is running.
	 *
	 * Reads the digest each tenant recorded when it started, so a tenant nobody touched is left
	 * alone rather than restarted for symmetry.
	 */
	async swapChanged(): Promise<string[]> {
		const swapped: string[] = [];
		for (const tenant of this.options.config.tenants) {
			if (tenant.suspended === true) continue;
			const path = `${this.pathsFor(tenant.name).state}/${RUNTIME_DIGEST}`;
			const running = this.ctx.files.exists(path)
				? this.ctx.files.readText(path).trim()
				: null;
			if (running === tenantDigest(this.options.config, tenant)) continue;
			await this.swapTenant(tenant.name);
			swapped.push(tenant.name);
		}
		return swapped;
	}

	/**
	 * Performs a swap the CLI asked for, if it asked for one.
	 *
	 * Polled from the same timer as the health sweep rather than watched, because a missed inotify
	 * on a network filesystem is a reload that silently never happens and a poll cannot miss.
	 */
	async serveReloadRequest(): Promise<ReloadOutcome | null> {
		const request = `${this.options.config.state}/${RELOAD_REQUEST}`;
		if (!this.ctx.files.exists(request)) return null;
		this.ctx.files.remove(request);
		this.reread();

		const swapped: string[] = [];
		const failed: { tenant: string; reason: string }[] = [];
		for (const tenant of this.options.config.tenants) {
			if (tenant.suspended === true) continue;
			const path = `${this.pathsFor(tenant.name).state}/${RUNTIME_DIGEST}`;
			const running = this.ctx.files.exists(path)
				? this.ctx.files.readText(path).trim()
				: null;
			if (running === tenantDigest(this.options.config, tenant)) continue;
			try {
				await this.swapTenant(tenant.name);
				swapped.push(tenant.name);
			} catch (error) {
				// one tenant whose new configuration does not start must not take the others with
				// it; the outcome names it and the rest of the box carries on
				failed.push({
					tenant: tenant.name,
					reason: error instanceof Error ? error.message : String(error)
				});
			}
		}

		const outcome: ReloadOutcome = { at: this.ctx.now(), swapped, failed };
		this.ctx.files.writeText(
			`${this.options.config.state}/${RELOAD_OUTCOME}`,
			`${JSON.stringify(outcome)}\n`
		);
		return outcome;
	}

	async down(): Promise<void> {
		for (const supervisor of this.supervisors.values()) supervisor.stop();
		for (const listener of this.listeners.values()) await listener.stop(false);
		for (const bound of this.adapters.values()) {
			for (const listener of bound) await listener.stop(false);
		}
		this.listeners.clear();
		this.adapters.clear();
		this.supervisors.clear();
	}

	/** one tenant's supervisor, so `status` and the health ledger can read its restart count */
	supervisorFor(tenant: string): TenantSupervisor | undefined {
		return this.supervisors.get(tenant);
	}

	/**
	 * What every probe needs, read off this process and this host.
	 *
	 * Assembled here because this is the only place that holds both halves: the supervisors know
	 * their restart counts and breaker state, and the config knows the quotas and the residency. A
	 * field it cannot read is left absent rather than zeroed, which is what keeps an unmeasured
	 * input from reading as a healthy one.
	 */
	sample(): HealthInput {
		const config = this.options.config;
		const space = this.ctx.files.space(config.state);
		return {
			now: this.ctx.now(),
			config: { mode: config.mode, runtime: config.runtime, tenants: config.tenants },
			...(space === null
				? {}
				: { host: { totalBytes: space.totalBytes, freeBytes: space.freeBytes } }),
			tenants: config.tenants.map((tenant) => {
				const supervisor = this.supervisors.get(tenant.name);
				const process = supervisor?.snapshot();
				return {
					name: tenant.name,
					sites: tenant.sites.length,
					...(tenant.limits?.maxSites === undefined
						? {}
						: { maxSites: tenant.limits.maxSites }),
					...(process === undefined
						? {}
						: {
								restarts: Math.max(0, process.attempts - 1),
								quarantined: process.state === 'quarantined'
							})
				};
			}),
			front: {
				rateLimited: this.unattributed.get('rate-limited') ?? 0,
				slowloris: this.unattributed.get('slowloris') ?? 0,
				windowMs: this.ctx.now() - this.startedAt
			},
			isolation: { configured: config.mode, available: config.mode }
		};
	}

	/**
	 * Picks up the configuration file again, so a swap lands on what the operator wrote.
	 *
	 * A refusal here leaves the running configuration in place rather than taking the box down: an
	 * unparseable edit is a reason to keep serving the last good one and say so.
	 */
	private reread(): void {
		if (this.options.configPath === undefined) return;
		try {
			const loaded = loadConfig(this.ctx, { path: this.options.configPath });
			this.options = { ...this.options, config: loaded.config };
		} catch (error) {
			this.ctx.io.err(
				`the configuration did not load, so nothing changed: ` +
					`${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/** detects, records what is new, and clears what recovered; returns what is currently open */
	health(): Finding[] {
		return sweep(this.ledger, this.sample());
	}

	get running(): string[] {
		return [...this.supervisors.keys()];
	}
}
