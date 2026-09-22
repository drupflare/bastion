/**
 * The handlers that cannot be a command, because their answer lives in the running process.
 *
 * Everything else routes through the CLI so the two surfaces cannot disagree. The analytics window
 * has no CLI equivalent to route through: it is an in-memory ring of served requests held by the
 * `serve` process, and a second process asking the same question has nothing to read. These close
 * over the runtime instead, and are merged OVER the command-backed map.
 */

import type { Runtime } from '@drupflare/bastion';
import { type ApiHandler } from '@drupflare/bastion';

/** the window the analytics view asks for, defaulting to the last day */
function windowOf(request: Request): { from: number; to: number } {
	const asked = new URL(request.url).searchParams;
	const to = Number(asked.get('to') ?? Date.now());
	const from = Number(asked.get('from') ?? to - 24 * 60 * 60 * 1000);
	return { from: Number.isFinite(from) ? from : 0, to: Number.isFinite(to) ? to : Date.now() };
}

export function liveHandlers(
	runtime: Runtime,
	/** the command-backed map, for the representations that are still a command */
	fallback: Record<string, ApiHandler>
): Record<string, ApiHandler> {
	return {
		/**
		 * Two representations of one route, chosen by `Accept`.
		 *
		 * Prometheus scrapes the exposition format and the console wants rows it can render, and
		 * they are the same question about the same box. A second route would have meant a second
		 * name for it in the table, the manual and the dashboard.
		 */
		'GET /api/metrics': (input) => {
			const { request, tenant } = input;
			const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
			// the exposition format is still what a scrape gets, and it is still the CLI's
			if (!wantsJson) return fallback['GET /api/metrics']?.(input);

			const window = windowOf(request);
			const scope = tenant ?? undefined;
			return {
				window,
				sites: runtime.analytics.summarise(window, scope),
				statuses: runtime.analytics.statuses(window, scope),
				series: runtime.analytics.series(window, 24, scope),
				// refusals decided before routing belong to no tenant, so an operator sees them
				// and a tenant credential does not
				unattributed: tenant === null ? Object.fromEntries(runtime.unattributed) : {}
			};
		}
	};
}
