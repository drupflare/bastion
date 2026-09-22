import type { Adapter, Context } from '@drupflare/bastion';
import { BastionError, DRIVERS, knownDriver } from '@drupflare/bastion';
import { kv } from '../format';
import { emit, load, type Globals } from '../state';

/** the adapters an operator can inspect, and the config key each one reads */
export const STORES = ['kv', 'r2', 'd1', 'queues', 'cache'] as const;
export type Store = (typeof STORES)[number];

const OPERATIONS = ['get', 'put', 'list', 'rm', 'stats'] as const;

/**
 * Operator inspection of one adapter.
 *
 * The operation is checked here rather than passed through, because an unknown one against a live
 * store is a request that may have done something. `stats` is the only operation that needs no
 * argument, so it is what a bare invocation answers.
 */
export function runStore(
	ctx: Context,
	globals: Globals & { key?: string; value?: string; prefix?: string },
	store: Store,
	operation: string
): number {
	if (!OPERATIONS.includes(operation as (typeof OPERATIONS)[number])) {
		throw new BastionError('usage', `${operation} is not one of ${OPERATIONS.join(', ')}`, {
			next: `bastion ${store} stats`
		});
	}

	const loaded = load(ctx, globals);
	const configured = (loaded.config.drivers as unknown as Record<string, { driver: string }>)[
		store
	];
	if (configured === undefined) {
		throw new BastionError('config-invalid', `no ${store} driver is configured`, {
			next: 'bastion config show'
		});
	}

	const known = knownDriver(store as Adapter, configured.driver);
	const report = {
		store,
		operation,
		driver: configured.driver,
		known,
		available: DRIVERS[store as Adapter]
	};

	if (!known) {
		emit(
			ctx,
			globals,
			report,
			() =>
				`${configured.driver} is not a ${store} driver bastion knows; it has ` +
				`${report.available.join(', ')}`
		);
		return 3;
	}

	// the store's own contents need the running process that holds it; the CLI reports what is
	// configured and refuses to invent an answer for a store it is not attached to
	emit(ctx, globals, report, () =>
		[
			kv([
				['store', store],
				['driver', configured.driver],
				['operation', operation]
			]),
			'',
			`${store} is served by the running bastion. Start it with \`bastion up\` and read this ` +
				`store through the dashboard or the management API.`
		].join('\n')
	);
	return 0;
}
