import { createHash } from 'node:crypto';
import type { Context } from '../context';
import { BastionError } from '../errors';

export interface Version {
	/** the content address of the bundle; two identical uploads are one version */
	id: string;
	site: string;
	bytes: number;
	uploadedAt: number;
	uploadedBy: string;
	/** free-form, so a caller can carry a git sha or a release tag */
	annotations: Record<string, string>;
}

export interface Deployment {
	site: string;
	/** the version every request goes to unless the split sends it elsewhere */
	current: string;
	/** a canary version and the share of traffic it takes, or null */
	split: { version: string; percent: number } | null;
	at: number;
	by: string;
}

export function versionId(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

/**
 * Content-addressed versions with a deployment pointer.
 *
 * bastion owns its router, so versions and deployments are real here rather than a label on a
 * single artifact: a rollout is a genuine percentage split at the front door and a rollback is a
 * pointer move, not a re-upload.
 */
export class VersionStore {
	private readonly versions = new Map<string, Version>();
	private readonly deployments = new Map<string, Deployment>();
	private readonly history = new Map<string, Deployment[]>();
	private readonly disk: { ctx: Context; path: string } | null;

	/**
	 * Optionally backed by a file, which is what the CLI needs.
	 *
	 * `bastion deploy` and `bastion version list` are two processes, so a store that only lives in
	 * memory answers "no versions" to the second one. The bytes themselves are not kept here, only
	 * the content address and the pointer; a bundle lives where the tenant's state does.
	 */
	constructor(backing?: { ctx: Context; path: string }) {
		this.disk = backing ?? null;
		this.load();
	}

	private load(): void {
		if (this.disk === null || !this.disk.ctx.files.exists(this.disk.path)) return;
		let saved: {
			versions?: Version[];
			deployments?: Deployment[];
			history?: Record<string, Deployment[]>;
		};
		try {
			saved = JSON.parse(this.disk.ctx.files.readText(this.disk.path));
		} catch {
			// a truncated file is not a reason to refuse every command; it is reported by `status`
			return;
		}
		for (const version of saved.versions ?? []) {
			this.versions.set(`${version.site}/${version.id}`, version);
		}
		for (const deployment of saved.deployments ?? []) {
			this.deployments.set(deployment.site, deployment);
		}
		for (const [site, entries] of Object.entries(saved.history ?? {})) {
			this.history.set(site, entries);
		}
	}

	private save(): void {
		if (this.disk === null) return;
		this.disk.ctx.files.writeText(
			this.disk.path,
			JSON.stringify(
				{
					versions: [...this.versions.values()],
					deployments: [...this.deployments.values()],
					history: Object.fromEntries(this.history)
				},
				null,
				2
			)
		);
	}

	add(
		site: string,
		bytes: Uint8Array,
		by: string,
		at: number,
		annotations: Record<string, string> = {}
	): Version {
		const id = versionId(bytes);
		const existing = this.versions.get(`${site}/${id}`);
		if (existing !== undefined) return existing;
		const version: Version = {
			id,
			site,
			bytes: bytes.length,
			uploadedAt: at,
			uploadedBy: by,
			annotations
		};
		this.versions.set(`${site}/${id}`, version);
		this.save();
		return version;
	}

	list(site: string): Version[] {
		return [...this.versions.values()]
			.filter((version) => version.site === site)
			.sort((a, b) => a.uploadedAt - b.uploadedAt);
	}

	get(site: string, id: string): Version | null {
		return this.versions.get(`${site}/${id}`) ?? null;
	}

	deploy(site: string, id: string, by: string, at: number): Deployment {
		if (this.get(site, id) === null) {
			throw new BastionError('usage', `${site} has no version ${id}`);
		}
		const deployment: Deployment = { site, current: id, split: null, at, by };
		this.deployments.set(site, deployment);
		this.history.set(site, [...(this.history.get(site) ?? []), deployment]);
		this.save();
		return deployment;
	}

	/** a real split, refused above 100 and refused at a version that was never uploaded */
	rollout(site: string, id: string, percent: number, by: string, at: number): Deployment {
		if (this.get(site, id) === null)
			throw new BastionError('usage', `${site} has no version ${id}`);
		if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
			throw new BastionError('usage', `${percent} is not a percentage`);
		}
		const current = this.deployments.get(site);
		if (current === undefined)
			throw new BastionError('usage', `${site} has nothing deployed yet`);
		const deployment: Deployment = {
			...current,
			split: percent === 0 ? null : { version: id, percent },
			at,
			by
		};
		this.deployments.set(site, deployment);
		this.history.set(site, [...(this.history.get(site) ?? []), deployment]);
		this.save();
		return deployment;
	}

	deployment(site: string): Deployment | null {
		return this.deployments.get(site) ?? null;
	}

	/** the version before the current one, which is what a rollback with no argument goes to */
	rollback(site: string, by: string, at: number, to?: string): Deployment {
		const past = this.history.get(site) ?? [];
		if (to !== undefined) return this.deploy(site, to, by, at);
		const current = this.deployments.get(site);
		const previous = [...past].reverse().find((entry) => entry.current !== current?.current);
		if (previous === undefined) {
			throw new BastionError('usage', `${site} has nothing to roll back to`, {
				next: 'bastion version list'
			});
		}
		return this.deploy(site, previous.current, by, at);
	}

	historyFor(site: string): Deployment[] {
		return [...(this.history.get(site) ?? [])];
	}
}

/**
 * Which version one request goes to.
 *
 * Keyed on a stable value rather than randomly, so a visitor stays on one side of the split for
 * the whole of a session. Splitting per request would show a user half of each version, which on a
 * CMS with a session cookie is how a rollout produces a support ticket rather than a signal.
 */
export function pickVersion(deployment: Deployment, key: string): string {
	if (deployment.split === null) return deployment.current;
	let hash = 0x811c9dc5;
	for (const char of key) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash % 100 < deployment.split.percent ? deployment.split.version : deployment.current;
}
