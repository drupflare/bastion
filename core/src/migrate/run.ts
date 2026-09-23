import type { Context } from '../context';
import type { MigrationPlan, SitePlan } from './plan';

export type SiteStage = 'pending' | 'exporting' | 'provisioning' | 'replaying' | 'done' | 'failed';

export interface SiteProgress {
	host: string;
	stage: SiteStage;
	/** chunks replayed of the total, so a resume knows where it stopped */
	chunk: number;
	chunks: number;
	error: string | null;
}

export interface Checkpoint {
	startedAt: number;
	source: string;
	sites: SiteProgress[];
}

export interface MigrationHooks {
	/** drangler owns the source half; bastion invokes it rather than copying it */
	exportSite(site: SitePlan, cursor: number): Promise<{ chunks: number; done: boolean }>;
	provisionSite(site: SitePlan): Promise<void>;
	/** the chunked replay the smoke lane already proved, driven on the alarm chain */
	replayChunk(site: SitePlan, chunk: number): Promise<void>;
}

/**
 * Runs a migration, checkpointing at the SITE boundary.
 *
 * A multi-site VPS is a long operation, and drangler's own checkpointing already makes each site's
 * dump resumable. Checkpointing here as well means a failed tenth site does not re-move the first
 * nine, which is the difference between a retry and a restart.
 *
 * **Nothing is deleted at the source.** bastion imports; decommissioning the origin is the
 * operator's separate and deliberate act.
 */
export class MigrationRun {
	private readonly ctx: Context;
	private readonly path: string;
	private checkpoint: Checkpoint;

	constructor(ctx: Context, path: string, plan: MigrationPlan) {
		this.ctx = ctx;
		this.path = path;
		this.checkpoint = this.load() ?? {
			startedAt: ctx.now(),
			source: plan.source,
			sites: plan.sites.map((site) => ({
				host: site.site.host,
				stage: 'pending' as const,
				chunk: 0,
				chunks: 0,
				error: null
			}))
		};
	}

	private load(): Checkpoint | null {
		if (!this.ctx.files.exists(this.path)) return null;
		return JSON.parse(this.ctx.files.readText(this.path)) as Checkpoint;
	}

	private save(): void {
		this.ctx.files.writeText(this.path, JSON.stringify(this.checkpoint, null, 2));
	}

	get progress(): SiteProgress[] {
		return this.checkpoint.sites.map((site) => ({ ...site }));
	}

	private update(host: string, patch: Partial<SiteProgress>): void {
		this.checkpoint = {
			...this.checkpoint,
			sites: this.checkpoint.sites.map((site) =>
				site.host === host ? { ...site, ...patch } : site
			)
		};
		this.save();
	}

	/** runs every site that is not already done; a resume picks up at the chunk it stopped on */
	async run(plan: MigrationPlan, hooks: MigrationHooks): Promise<SiteProgress[]> {
		for (const site of plan.sites) {
			const state = this.checkpoint.sites.find((entry) => entry.host === site.site.host);
			if (state === undefined || state.stage === 'done') continue;
			if (!site.fits) {
				this.update(site.site.host, { stage: 'failed', error: site.blockedBy });
				continue;
			}

			try {
				this.update(site.site.host, { stage: 'exporting', error: null });
				const exported = await hooks.exportSite(site, state.chunk);
				this.update(site.site.host, { chunks: exported.chunks });

				this.update(site.site.host, { stage: 'provisioning' });
				await hooks.provisionSite(site);

				this.update(site.site.host, { stage: 'replaying' });
				for (let chunk = state.chunk; chunk < exported.chunks; chunk++) {
					await hooks.replayChunk(site, chunk);
					this.update(site.site.host, { chunk: chunk + 1 });
				}
				this.update(site.site.host, { stage: 'done' });
			} catch (e) {
				this.update(site.site.host, {
					stage: 'failed',
					error: e instanceof Error ? e.message : String(e)
				});
			}
		}
		return this.progress;
	}

	get done(): boolean {
		return this.checkpoint.sites.every((site) => site.stage === 'done');
	}

	get failed(): SiteProgress[] {
		return this.checkpoint.sites.filter((site) => site.stage === 'failed');
	}
}

/**
 * Why bastion does not seed the `.sqlite` file directly on disk.
 *
 * Tempting, and bastion uniquely could, since Durable Object storage is a local file here. Two
 * reasons not to, recorded so nobody re-proposes it as an optimisation. The object's filename
 * derives from an id CRYPTOGRAPHICALLY DERIVED from `uniqueKey`, a workerd internal with no stable
 * public derivation, and writing it by hand would make bastion depend on a format its own schema
 * warns is subject to backwards-incompatible change. And it would route around the one acceptance
 * test that matters: that the same payload runs unmodified.
 */
export const DIRECT_SEED_REFUSED =
	'bastion replays a site through the same path a running site uses rather than writing the ' +
	'object file directly; the object id is derived from a workerd internal and seeding it would ' +
	'route around the acceptance test that the same payload runs unmodified';
