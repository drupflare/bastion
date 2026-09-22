import { createHash } from 'node:crypto';
import { buildAdapters, type AdapterClients, type AdapterInput } from '../adapters/build';
import { ADAPTER_SLOTS, handleSlot, type AdapterSet } from '../adapters/server';
import { handleApi, type ApiDeps, type ApiHandler } from '../api/server';
import { renderConfig, type CapnpConfig } from '../capnp/generate';
import { modulesFrom, planSite, socketFor } from '../capnp/plan';
import {
	DEFAULT_COMPATIBILITY_DATE,
	DEFAULT_COMPATIBILITY_FLAGS,
	resolveSiteWorker
} from '../config/defaults';
import type { BastionConfig, SiteConfig, TenantConfig } from '../config/types';
import type { Context } from '../context';
import { BastionError } from '../errors';
import { buildFront, listenerSpec } from '../front/door';
import { handleRequest, type FrontDeps } from '../front/handler';
import type { Listener, ListenerHost, TlsMaterial } from '../front/listener';
import { swapListener } from '../front/listener';
import type { Route } from '../front/router';
import { TENANT_SOCKET } from '../front/upstream';
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

export interface RuntimeOptions {
	config: BastionConfig;
	host: ListenerHost;
	/** proxies a sanitised request to the tenant's workerd over its unix socket */
	upstream(route: Route, request: Request, client: string): Promise<Response>;
	api?: Record<string, ApiHandler>;
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
	private readonly options: RuntimeOptions;
	private readonly supervisors = new Map<string, TenantSupervisor>();
	private readonly listeners = new Map<string, Listener>();
	/** one unix listener per adapter slot, per tenant, torn down with the tenant */
	private readonly adapters = new Map<string, Listener[]>();
	private readonly challenges = httpResponder();
	private front: FrontDeps | null = null;
	/** every served request lands here, which is what the analytics view reads */
	readonly analytics = new AnalyticsWindow();
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

		// A unix socket outlives the process that bound it, and workerd answers `Address already in
		// use` rather than replacing it. An unclean stop -- a kill, an OOM, a power loss -- therefore
		// left a file that stopped the tenant starting ever again, with nothing saying why.
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
			// the dead process still holds its socket name, and workerd refuses to bind over one.
			// Only this tenant's own listen socket: the adapter sockets beside it are bound by
			// bastion and are still live
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

	/** the management listener, which is a different origin from every tenant's site */
	async serveManagement(request: Request): Promise<Response> {
		const { sessions, tokens } = this.options;
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
	async bind(which: 'http' | 'https', tls?: TlsMaterial[]): Promise<Listener> {
		const spec = listenerSpec(this.options.config, which, tls);
		const next = await swapListener(
			this.options.host,
			this.listeners.get(which) ?? null,
			spec,
			(request, peer) => this.serve(request, peer)
		);
		this.listeners.set(which, next);
		return next;
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
				// An https listener with no keypair binds PLAINTEXT and reports itself as https, so
				// a visitor typing the url gets cleartext on the port that exists to encrypt it and
				// the operator reads `https on 0.0.0.0:443` and believes otherwise.
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
			return {
				mode,
				tenants: [...this.supervisors.keys()],
				listeners: bound,
				warnings
			};
		} catch (error) {
			await this.down();
			throw error;
		}
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

	get running(): string[] {
		return [...this.supervisors.keys()];
	}
}
