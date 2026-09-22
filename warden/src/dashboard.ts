import { bundleFrom, type AssetBundle } from '@drupflare/bastion';
import { DASHBOARD_FILES } from './dashboard-assets';

let decoded: AssetBundle | null = null;

/**
 * The embedded dashboard, decoded once.
 *
 * Empty in a build that skipped `bun run build:dashboard`, which the listener answers with a page
 * saying so rather than a blank 404. A binary that silently serves nothing at its own address is
 * indistinguishable from a binary that is not running.
 */
export function dashboardAssets(): AssetBundle {
	if (decoded !== null) return decoded;
	const files: Record<string, Uint8Array> = {};
	for (const [path, base64] of Object.entries(DASHBOARD_FILES)) {
		files[path] = new Uint8Array(Buffer.from(base64, 'base64'));
	}
	decoded = bundleFrom(files);
	return decoded;
}
