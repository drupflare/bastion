import { handleApi, type ApiDeps, type ApiHandler } from '../api/server';
import type { BastionConfig } from '../config/types';
import type { Context } from '../context';
import { BastionError } from '../errors';
import { buildFront, listenerSpec } from '../front/door';
import { handleRequest, type FrontDeps } from '../front/handler';
import type { Listener, ListenerHost, TlsMaterial } from '../front/listener';
import { swapListener } from '../front/listener';
import type { Route } from '../front/router';
import { applyCgroup, attachPid } from '../isolation/cgroups';
import { assertModeSafe } from '../isolation/modes';
import { modeAvailable, preflight } from '../isolation/preflight';
import {
	createNetns,
	installApparmorProfile,
	sandboxArgv,
	type SandboxPaths
} from '../isolation/sandbox';
import { AnalyticsWindow } from '../observe/analytics';
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
	private readonly challenges = httpResponder();
	private front: FrontDeps | null = null;
	/** every served request lands here, which is what the analytics view reads */
	readonly analytics = new AnalyticsWindow();
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
		applyCgroup(this.ctx, tenant, declared.limits ?? {});

		if (config.mode === 'hardened') {
			await createNetns(this.ctx, tenant);
			await installApparmorProfile(this.ctx, tenant, paths, binary);
		}

		const wrapped = sandboxArgv({ mode: config.mode, tenant, paths }, binary, []);
		const supervisor = new TenantSupervisor(this.ctx, tenant, {
			binary: wrapped.command,
			configPath: paths.config
		});
		const started = supervisor.start();
		if (started.pid !== null) attachPid(this.ctx, tenant, started.pid);
		this.supervisors.set(tenant, supervisor);
		return supervisor;
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

	async up(): Promise<RuntimeState> {
		const { mode, warnings } = this.preflight();
		for (const tenant of this.options.config.tenants) {
			if (this.options.binary === undefined) break;
			await this.startTenant(tenant.name);
		}
		const bound: { which: string; address: string }[] = [];
		if (this.options.config.listeners.http !== undefined) {
			const listener = await this.bind('http');
			bound.push({ which: 'http', address: `${listener.hostname}:${listener.port}` });
		}
		if (this.options.config.listeners.https !== undefined) {
			const listener = await this.bind('https', this.material());
			bound.push({ which: 'https', address: `${listener.hostname}:${listener.port}` });
		}
		return {
			mode,
			tenants: [...this.supervisors.keys()],
			listeners: bound,
			warnings
		};
	}

	async down(): Promise<void> {
		for (const supervisor of this.supervisors.values()) supervisor.stop();
		for (const listener of this.listeners.values()) await listener.stop(false);
		this.listeners.clear();
		this.supervisors.clear();
	}

	get running(): string[] {
		return [...this.supervisors.keys()];
	}
}
