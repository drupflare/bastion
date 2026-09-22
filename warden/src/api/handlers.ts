/**
 * What every management route actually does.
 *
 * Each one runs the CLI command the route table already names, under `--json`, against a capturing
 * io. That is not a shortcut: `--json` prints the object the text render derives from, so routing
 * the API through it makes the dashboard and the terminal structurally incapable of disagreeing.
 * A second implementation of "list the tenants" is the drift that costs a correctness property,
 * and the route table has carried the command name since it was written.
 *
 * **A tenant-scoped principal is narrowed here, after the command runs.** `authorize` checks the
 * action and the tenant the SESSION carries; it never sees a hostname, so a route addressed by
 * site is one a tenant-admin could otherwise point at another tenant's site. Every such route
 * calls {@link assertOwns} before it builds an argv.
 */

import {
	BastionError,
	EXIT,
	memoryIo,
	ROUTES,
	type ApiHandler,
	type Context
} from '@drupflare/bastion';
import { run } from '../run';
import { load, type Globals } from '../state';

type Input = Parameters<ApiHandler>[0];

interface RouteImpl {
	/** the argv this route runs; `--json` and the global config path are added by the caller */
	argv(input: Input): string[] | Promise<string[]>;
	/** stdout is the answer, for a command that renders a format of its own rather than json */
	text?: boolean;
	/** what a tenant-scoped principal is allowed to see of the result */
	scope?(result: unknown, tenant: string): unknown;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
	if (request.method === 'GET' || request.method === 'DELETE') return {};
	try {
		const parsed: unknown = await request.json();
		return typeof parsed === 'object' && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		throw new BastionError('usage', 'the request body is not json', { next: null });
	}
}

/** a required field, refused by name rather than passed to a command as `undefined` */
function need(body: Record<string, unknown>, field: string): string {
	const value = body[field];
	if (typeof value !== 'string' || value === '') {
		throw new BastionError('usage', `this route needs a ${field}`, { next: null });
	}
	return value;
}

/** an optional field as a flag pair, or nothing */
function flag(value: unknown, name: string): string[] {
	if (value === undefined || value === null || value === '') return [];
	return [name, String(value)];
}

const query = (request: Request, name: string): string | null =>
	new URL(request.url).searchParams.get(name);

const rows = (result: unknown, key: string): Record<string, unknown>[] => {
	const holder = result as Record<string, unknown> | null;
	const value = holder?.[key];
	return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
};

/**
 * Refuses a site the principal does not hold.
 *
 * The hostname comes from the path, and a path is client input. `authorize` has already decided
 * this credential may deploy; it has no way to know whose site this is, so this is the check that
 * keeps one department's tenant-admin out of another department's site.
 */
function assertOwns(ctx: Context, globals: Globals, host: string, tenant: string | null): void {
	if (tenant === null) return;
	const loaded = load(ctx, globals);
	const owner = loaded.config.tenants.find((entry) =>
		entry.sites.some((site) => site.host === host)
	);
	if (owner?.name !== tenant) {
		throw new BastionError(
			'capability-refused',
			`that credential is scoped to ${tenant} and cannot reach ${host}`
		);
	}
}

export function implementations(globals: Globals): Record<string, RouteImpl> {
	/** the host a site-addressed route acts on, checked against the principal before it is used */
	const owned = (input: Input, host: string): string => {
		assertOwns(input.ctx, globals, host, input.tenant);
		return host;
	};

	return {
		'GET /api/status': {
			argv: () => ['status'],
			scope: (result, tenant) => ({
				...(result as object),
				tenants: rows(result, 'tenants').filter((row) => row.tenant === tenant)
			})
		},
		'GET /api/doctor': { argv: () => ['doctor'] },
		'GET /api/capabilities': { argv: () => ['capability', 'list'] },
		'POST /api/capabilities/:slot/install': {
			argv: ({ params }) => ['capability', 'install', params.slot as string]
		},
		'GET /api/health': { argv: () => ['health'] },
		'GET /api/metrics': {
			argv: () => ['metrics'],
			text: true,
			// a series carries its tenant as a label, so the narrowing reads the same label the
			// text render does rather than a second idea of what belongs to whom
			scope: (result, tenant) =>
				String(result)
					.split('\n')
					.filter((line) => line.startsWith('#') || line.includes(`tenant="${tenant}"`))
					.join('\n')
		},
		'GET /api/logs': {
			argv: ({ request, tenant }) => [
				'logs',
				...flag(tenant ?? query(request, 'tenant'), '--tenant'),
				...flag(query(request, 'level'), '--level')
			]
		},
		'GET /api/config': { argv: () => ['config', 'show'] },
		'PUT /api/config': {
			argv: async ({ request }) => {
				const body = await readBody(request);
				return ['config', 'set', need(body, 'key'), need(body, 'value')];
			}
		},
		'GET /api/tenants': {
			argv: () => ['tenant', 'list'],
			scope: (result, tenant) => ({
				tenants: rows(result, 'tenants').filter((row) => row.name === tenant)
			})
		},
		'POST /api/tenants': {
			argv: async ({ request }) => {
				const body = await readBody(request);
				return [
					'tenant',
					'add',
					need(body, 'name'),
					...flag(body.cpu, '--cpu'),
					...flag(body.memory, '--memory'),
					...flag(body.maxSites, '--max-sites')
				];
			}
		},
		'DELETE /api/tenants/:tenant': {
			argv: ({ params }) => ['tenant', 'rm', params.tenant as string, '--yes']
		},
		'GET /api/sites': {
			argv: () => ['site', 'list'],
			scope: (result, tenant) => ({
				sites: rows(result, 'sites').filter((row) => row.tenant === tenant)
			})
		},
		'POST /api/sites': {
			argv: async ({ request, tenant }) => {
				const body = await readBody(request);
				// a tenant credential adds to its own tenant whatever the body says
				const named = tenant ?? body.tenant;
				return [
					'site',
					'add',
					need(body, 'host'),
					...flag(named, '--tenant'),
					...flag(body.bundle, '--bundle'),
					...flag(body.template, '--template'),
					...flag(body.probe, '--probe'),
					...flag(body.checksum, '--checksum'),
					...(body.insecureSource === true ? ['--insecure-source'] : [])
				];
			}
		},
		'DELETE /api/sites/:site': {
			argv: (input) => ['site', 'rm', owned(input, input.params.site as string)]
		},
		'POST /api/sites/:site/deploy': {
			argv: async (input) => {
				const host = owned(input, input.params.site as string);
				const body = await readBody(input.request);
				return [
					'deploy',
					host,
					need(body, 'bundle'),
					...flag(body.checksum, '--checksum'),
					...(body.insecureSource === true ? ['--insecure-source'] : [])
				];
			}
		},
		'POST /api/sites/:site/rollout': {
			argv: async (input) => {
				const host = owned(input, input.params.site as string);
				const body = await readBody(input.request);
				return [
					'rollout',
					host,
					...flag(body.version ?? body.to, '--to'),
					...flag(body.percent, '--percent')
				];
			}
		},
		'POST /api/sites/:site/rollback': {
			argv: async (input) => {
				const host = owned(input, input.params.site as string);
				const body = await readBody(input.request);
				return ['rollback', host, ...flag(body.to, '--to')];
			}
		},
		'GET /api/versions': {
			argv: (input) => {
				const host = query(input.request, 'host');
				if (host === null || host === '') {
					throw new BastionError('usage', 'this route needs a ?host=', { next: null });
				}
				return ['versions', 'list', owned(input, host)];
			}
		},
		'GET /api/backups': { argv: () => ['backup', 'list'] },
		'POST /api/backups': {
			argv: async ({ request }) => {
				const body = await readBody(request);
				return ['backup', 'now', ...flag(body.site, '--site')];
			}
		},
		'POST /api/repair/:code': {
			argv: async ({ params, request }) => {
				const body = await readBody(request);
				return ['repair', params.code as string, ...flag(body.rung, '--rung')];
			}
		},
		'GET /api/quarantine': { argv: () => ['quarantine', 'list'] },
		'GET /api/secrets': { argv: () => ['secrets', 'list'] },
		'PUT /api/secrets/:name': {
			argv: async ({ params, request }) => {
				const body = await readBody(request);
				return ['secrets', 'set', params.name as string, '--value', need(body, 'value')];
			}
		},
		'GET /api/audit': { argv: () => ['audit', 'tail'] },
		'GET /api/cluster': { argv: () => ['cluster', 'status'] },
		'POST /api/cluster/nodes': {
			argv: async ({ request }) => {
				const body = await readBody(request);
				return [
					'cluster',
					'join',
					'--control',
					need(body, 'control'),
					...flag(body.token, '--token')
				];
			}
		},
		'GET /api/capacity': {
			argv: ({ request }) => ['capacity', ...flag(query(request, 'whatIf'), '--what-if')]
		}
	};
}

/** the shape `run` prints under `--json` on the failure path */
interface CliError {
	error?: { code?: string; message?: string; next?: string | null };
}

export function apiHandlers(globals: Globals): Record<string, ApiHandler> {
	const table = implementations(globals);
	const base = globals.config === undefined ? [] : ['--config', globals.config];
	const handlers: Record<string, ApiHandler> = {};

	for (const route of ROUTES) {
		const key = `${route.method} ${route.path}`;
		const impl = table[key];
		if (impl === undefined) continue;

		handlers[key] = async (input) => {
			const io = memoryIo();
			const built = await impl.argv(input);
			const argv = [...base, ...built, ...(impl.text === true ? [] : ['--json'])];
			const code = await run({ ...input.ctx, io }, argv);
			const out = io.outText().trim();
			const narrow = (value: unknown): unknown =>
				input.tenant === null || impl.scope === undefined
					? value
					: impl.scope(value, input.tenant);

			// 3 is "ran and found something", which is a result rather than a failure
			const ran = code === EXIT.OK || code === EXIT.FINDING;
			if (impl.text === true) {
				if (!ran) {
					throw new BastionError(
						'internal',
						io.errText().trim() || out || 'the command failed'
					);
				}
				return narrow(out);
			}

			let parsed: unknown = null;
			try {
				parsed = JSON.parse(out.split('\n').pop() ?? '');
			} catch {
				parsed = null;
			}
			if (!ran) {
				const failure = (parsed as CliError | null)?.error;
				throw new BastionError(
					(failure?.code ?? 'internal') as 'internal',
					(failure?.message ?? io.errText().trim()) || 'the command failed',
					{ exitCode: code, next: failure?.next ?? null }
				);
			}
			if (parsed === null) {
				throw new BastionError('internal', `${argv.join(' ')} printed nothing to parse`);
			}
			return narrow(parsed);
		};
	}
	return handlers;
}
