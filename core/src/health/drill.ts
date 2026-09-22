import type { BackupEngine } from '../backup/engine';
import type { Context } from '../context';

export interface DrillResult {
	ok: boolean;
	site: string;
	version: number | null;
	/** each step and whether it passed, so a failure names which half broke */
	steps: { step: string; ok: boolean; detail: string }[];
}

export interface DrillOptions {
	/** brings a scratch tenant up on the restored bytes and answers the probe path */
	boot(bytes: Uint8Array): Promise<{ status: number; body: Uint8Array }>;
	/** the page to compare, byte for byte */
	expected?: Uint8Array;
	teardown?(): Promise<void>;
}

/**
 * Restores the newest backup into a scratch tenant and renders a page from it.
 *
 * A backup nobody has restored is not a backup. Scheduled by default, and a drill that has NEVER
 * run is a `warn` rather than silence -- the absence of a result reads as a pass otherwise, which
 * is exactly how "our backups have never worked" becomes something a disaster discovers.
 */
export async function drill(
	ctx: Context,
	engine: BackupEngine,
	site: string,
	options: DrillOptions
): Promise<DrillResult> {
	const steps: DrillResult['steps'] = [];
	let version: number | null = null;
	try {
		const restored = await engine.restore(site);
		version = restored.manifest.version;
		steps.push({ step: 'restore', ok: true, detail: `version ${version}` });

		const verified = await engine.verify(site, version);
		steps.push({
			step: 'verify',
			ok: verified.ok,
			detail: verified.ok
				? 'every frame present'
				: `${verified.missing.length} frames missing`
		});

		const answered = await options.boot(restored.bytes);
		const booted = answered.status === 200;
		steps.push({
			step: 'boot',
			ok: booted,
			detail: booted ? 'the probe answered 200' : `the probe answered ${answered.status}`
		});

		if (options.expected !== undefined) {
			const same =
				answered.body.length === options.expected.length &&
				answered.body.every((byte, i) => byte === options.expected?.[i]);
			steps.push({
				step: 'compare',
				ok: same,
				detail: same
					? 'the page is byte-identical'
					: 'the page differs from the expected bytes'
			});
		}
	} catch (e) {
		steps.push({
			step: 'restore',
			ok: false,
			detail: e instanceof Error ? e.message : String(e)
		});
	} finally {
		await options.teardown?.().catch(() => {});
	}
	void ctx;
	return { ok: steps.every((step) => step.ok), site, version, steps };
}
