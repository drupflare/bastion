/**
 * A Worker template, read from the manifest it already ships.
 *
 * Wrangler's `wrangler.jsonc` is the declaration a Worker already carries, so bastion reads it
 * rather than asking an operator to restate the same bindings in bastion's own vocabulary. What
 * bastion cannot honour is DECLARED here, in the shape `workforce`'s `PlaneCapabilities` uses:
 * every binding comes back either carried or refused with the reason, and nothing is dropped
 * quietly. A template whose store bastion has no backing for should read as a refusal at install
 * time, not as a Worker that boots and answers 500 on its first query.
 */

import type { SiteWorkerConfig } from '../config/types';
import type { Context } from '../context';
import { BastionError } from '../errors';

/** what happened to one binding in the manifest */
export interface BindingFinding {
	/** the binding name the bundle reads */
	name: string;
	/** the wrangler key it was declared under */
	type: string;
	carried: boolean;
	/** why it is not carried; empty when it is */
	reason: string;
}

export interface TemplatePlan {
	/** the block a site config carries, derived from the manifest */
	worker: SiteWorkerConfig;
	findings: BindingFinding[];
	/** cron expressions the manifest declares, which bastion has no scheduler for yet */
	crons: string[];
	name: string | null;
}

const carried = (name: string, type: string): BindingFinding => ({
	name,
	type,
	carried: true,
	reason: ''
});

const refused = (name: string, type: string, reason: string): BindingFinding => ({
	name,
	type,
	carried: false,
	reason
});

/**
 * Strips comments and trailing commas so `JSON.parse` accepts a `.jsonc`.
 *
 * String-aware: a `//` inside a value is data, and every manifest in the wild carries URLs.
 */
export function parseJsonc(text: string): unknown {
	let out = '';
	let inString = false;
	let escaped = false;
	let comment: 'line' | 'block' | null = null;

	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i] as string;
		const next = text[i + 1];

		if (comment === 'line') {
			if (ch === '\n') {
				comment = null;
				out += ch;
			}
			continue;
		}
		if (comment === 'block') {
			if (ch === '*' && next === '/') {
				comment = null;
				i += 1;
			}
			continue;
		}
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === '/' && next === '/') {
			comment = 'line';
			i += 1;
			continue;
		}
		if (ch === '/' && next === '*') {
			comment = 'block';
			i += 1;
			continue;
		}
		out += ch;
	}

	// a trailing comma before a closer is legal jsonc and not legal json
	const cleaned = out.replace(/,(\s*[}\]])/g, '$1');
	try {
		return JSON.parse(cleaned) as unknown;
	} catch (error) {
		throw new BastionError(
			'config-invalid',
			`the manifest is not valid jsonc: ${error instanceof Error ? error.message : String(error)}`,
			{ next: 'bastion site show' }
		);
	}
}

/** a block wrangler writes as one object with a `binding`, rather than as a list of them */
function single(value: unknown): string[] {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
	const binding = (value as Record<string, unknown>).binding;
	return typeof binding === 'string' && binding !== '' ? [binding] : [];
}

function names(value: unknown, key: string): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) =>
			entry !== null && typeof entry === 'object'
				? (entry as Record<string, unknown>)[key]
				: undefined
		)
		.filter((name): name is string => typeof name === 'string' && name !== '');
}

/**
 * Turns a wrangler manifest into the site's worker block, declaring every binding it drops.
 *
 * The refusals are the load-bearing half. A workerd `Service` is a four-way union and several
 * Cloudflare bindings have no field in the schema at all, so a binding bastion silently skipped
 * would deploy a Worker that starts and then fails on the one call the operator cared about.
 */
export function planFromManifest(manifest: unknown): TemplatePlan {
	if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
		throw new BastionError('config-invalid', 'the manifest is not an object', {
			next: 'bastion site show'
		});
	}
	const doc = manifest as Record<string, unknown>;
	const findings: BindingFinding[] = [];

	const kv = names(doc.kv_namespaces, 'binding');
	for (const name of kv) findings.push(carried(name, 'kv_namespaces'));

	const r2 = names(doc.r2_buckets, 'binding');
	for (const name of r2) findings.push(carried(name, 'r2_buckets'));

	const queues = names((doc.queues as Record<string, unknown> | undefined)?.producers, 'binding');
	for (const name of queues) findings.push(carried(name, 'queues'));

	// workerd carries no d1Database field, so this is not a native binding. It carries `wrapped`,
	// which instantiates an internal module against a service fetcher and makes whatever that
	// module returns the value of env.DB -- so D1 is built out of the binding that does exist
	const d1 = names(doc.d1_databases, 'binding');
	for (const name of d1) findings.push(carried(name, 'd1_databases'));

	// same mechanism. Cloudflare's catalogue is open-weight models, so the endpoint the operator
	// runs serves the same weights; what bastion supplies is the api shape in front of it
	const vectorize = names(doc.vectorize, 'binding');
	for (const name of vectorize) findings.push(carried(name, 'vectorize'));

	// native image work rather than a wasm decoder inside an isolate; bastion is an ordinary
	// process, so the constraint tinyimg was written against does not apply here
	const images = single(doc.images);
	for (const name of images) findings.push(carried(name, 'images'));

	// a Worker cannot open port 25, which is the whole reason this binding exists. bastion can, so
	// it dials the operator's own smtp server
	const email = names(doc.send_email, 'name').concat(single(doc.send_email));
	for (const name of email) findings.push(carried(name, 'send_email'));

	// workerd carries analyticsEngine natively but gates it behind --experimental, which also
	// unlocks unsafe-eval, the worker loader and the debug port; a wrapped binding takes none
	const analytics = names(doc.analytics_engine_datasets, 'binding');
	for (const name of analytics) findings.push(carried(name, 'analytics_engine_datasets'));

	// `hyperdrive @18-22` is a REAL group in the schema, so this is a native binding and workerd
	// does its own pooling over whatever the designator names
	const hyperdrive = (Array.isArray(doc.hyperdrive) ? doc.hyperdrive : [])
		.filter(
			(entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object'
		)
		.map((entry) => ({
			name: String(entry.binding ?? ''),
			database: String(entry.database ?? 'bastion'),
			user: String(entry.user ?? 'bastion'),
			password: String(entry.password ?? ''),
			scheme: String(entry.scheme ?? 'postgresql')
		}))
		.filter((entry) => entry.name !== '');
	for (const entry of hyperdrive) findings.push(carried(entry.name, 'hyperdrive'));

	// bastion owns its version store, so this is a value it already knows rather than a lookup
	const versionMetadata =
		typeof (doc.version_metadata as Record<string, unknown> | undefined)?.binding === 'string'
			? ((doc.version_metadata as Record<string, unknown>).binding as string)
			: undefined;
	if (versionMetadata !== undefined) findings.push(carried(versionMetadata, 'version_metadata'));

	const ai =
		typeof (doc.ai as Record<string, unknown> | undefined)?.binding === 'string'
			? [(doc.ai as Record<string, unknown>).binding as string]
			: [];
	for (const name of ai) findings.push(carried(name, 'ai'));

	const objects = (doc.durable_objects as Record<string, unknown> | undefined)?.bindings;
	const objectList = Array.isArray(objects) ? (objects as Record<string, unknown>[]) : [];
	let durableObject: string | undefined;
	let durableObjectClass: string | null = null;
	for (const [index, entry] of objectList.entries()) {
		const name = typeof entry.name === 'string' ? entry.name : '';
		const className = typeof entry.class_name === 'string' ? entry.class_name : '';
		if (name === '' || className === '') continue;
		if (typeof entry.script_name === 'string') {
			findings.push(
				refused(
					name,
					'durable_objects',
					'the class lives in another Worker, and a bastion tenant runs one worker per site'
				)
			);
			continue;
		}
		// one workerd process is one Durable Object consistency domain and the generator emits one
		// namespace, so a second class would bind to a namespace that is not there
		if (index > 0 && durableObject !== undefined) {
			findings.push(
				refused(name, 'durable_objects', 'bastion binds one Durable Object class per site')
			);
			continue;
		}
		durableObject = name;
		durableObjectClass = className;
		findings.push(carried(name, 'durable_objects'));
	}

	const assetsBlock = doc.assets as Record<string, unknown> | undefined;
	const assets = typeof assetsBlock?.binding === 'string' ? assetsBlock.binding : undefined;
	if (assets !== undefined) findings.push(carried(assets, 'assets'));

	const vars = doc.vars as Record<string, unknown> | undefined;
	for (const name of Object.keys(vars ?? {})) findings.push(carried(name, 'vars'));

	for (const [key, reason] of Object.entries(UNSUPPORTED)) {
		const given = doc[key];
		if (given === undefined) continue;
		const bound =
			typeof given === 'object' && given !== null && !Array.isArray(given)
				? [(given as Record<string, unknown>).binding]
				: names(given, 'binding');
		const listed = bound.filter((name): name is string => typeof name === 'string');
		for (const name of listed.length > 0 ? listed : [key]) {
			findings.push(refused(name, key, reason));
		}
	}

	const crons = (
		(doc.triggers as Record<string, unknown> | undefined)?.crons as unknown[] | undefined
	)?.filter((entry): entry is string => typeof entry === 'string');

	const flags = Array.isArray(doc.compatibility_flags)
		? doc.compatibility_flags.filter((f): f is string => typeof f === 'string')
		: undefined;

	return {
		name: typeof doc.name === 'string' ? doc.name : null,
		crons: crons ?? [],
		findings,
		worker: {
			...(typeof doc.main === 'string' ? { main: doc.main } : {}),
			durableObjectClass,
			...(durableObject === undefined ? {} : { durableObject }),
			...(assets === undefined ? {} : { assets }),
			kv,
			d1,
			vectorize,
			ai,
			images,
			email,
			analytics,
			hyperdrive,
			...(versionMetadata === undefined ? {} : { versionMetadata }),
			r2,
			queues,
			...(typeof doc.compatibility_date === 'string'
				? { compatibilityDate: doc.compatibility_date }
				: {}),
			...(flags === undefined ? {} : { compatibilityFlags: flags })
		}
	};
}

/** wrangler keys bastion has no backing for, each with the reason a caller can act on */
export const UNSUPPORTED: Record<string, string> = {
	mtls_certificates:
		'a client certificate for egress is not wired yet; the tenant reaches the endpoint through its egress allow list without one',
	pipelines:
		'the ingest buffer that batches records into r2 is not built yet; write to the r2 binding directly',
	dispatch_namespaces:
		'dispatching to another tenant would cross the process boundary that IS bastion isolation, and dispatching within one is a service binding'
};

/** every binding the manifest declared that bastion will not carry */
export function refusals(plan: TemplatePlan): BindingFinding[] {
	return plan.findings.filter((finding) => !finding.carried);
}

/** the file every Worker template ships its declaration in, in the order they are looked for */
export const MANIFEST_NAMES = ['wrangler.jsonc', 'wrangler.json'];

/** a template larger than this is refused unread; a bundle is modules, not a disk image */
export const MAX_TEMPLATE_BYTES = 256 * 1024 * 1024;

export interface PullOptions {
	/** where the extracted template lands */
	dest: string;
	/** substituted in the gate lane; the real one shells out to tar */
	extract?(archive: string, dest: string): Promise<void>;
}

function manifestIn(ctx: Context, dir: string): string {
	for (const name of MANIFEST_NAMES) {
		const path = `${dir}/${name}`;
		if (ctx.files.exists(path)) return path;
	}
	throw new BastionError(
		'config-invalid',
		`no ${MANIFEST_NAMES.join(' or ')} in ${dir}, so the template declares no bindings`,
		{ next: 'bastion site show' }
	);
}

/**
 * Reads a template that is already on disk.
 *
 * Separate from the fetch so an air-gapped install is the same code path as a pull, rather than a
 * second one that gets exercised half as often.
 */
export function readTemplate(ctx: Context, dir: string): TemplatePlan {
	return planFromManifest(parseJsonc(ctx.files.readText(manifestIn(ctx, dir))));
}

/**
 * Fetches a template archive and reads the manifest out of it.
 *
 * Only http and https are dialled. A `file:` or a bare path is read in place, because an operator
 * installing from a mounted volume is the air-gapped case the manual documents and there is
 * nothing to download. Extraction shells out to `tar` rather than carrying an implementation of
 * it: every host bastion runs on has one, and a decompressor is not what this project should own.
 */
export async function pullTemplate(
	ctx: Context,
	url: string,
	options: PullOptions
): Promise<TemplatePlan> {
	const local = url.startsWith('file://') ? url.slice('file://'.length) : url;
	if (!/^https?:\/\//.test(url)) {
		if (!ctx.files.exists(local)) {
			throw new BastionError('usage', `no template at ${local}`, {
				next: 'bastion site add --template'
			});
		}
		return readTemplate(ctx, local);
	}

	const response = await ctx.fetch(url);
	if (!response.ok) {
		throw new BastionError('usage', `the template at ${url} answered ${response.status}`, {
			retryable: response.status >= 500,
			next: 'bastion site add --template'
		});
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > MAX_TEMPLATE_BYTES) {
		throw new BastionError(
			'usage',
			`the template at ${url} is ${bytes.byteLength} bytes, over the ${MAX_TEMPLATE_BYTES} ceiling`,
			{ next: null }
		);
	}

	ctx.files.mkdirp(options.dest);
	const archive = `${options.dest}/.template-download`;
	ctx.files.writeBytes(archive, bytes);
	const extract =
		options.extract ??
		(async (from: string, to: string) => {
			// execFile, never a shell: a url-derived path must not be word-split
			const result = await ctx.runner.run('tar', ['-xzf', from, '-C', to]);
			if (result.code !== 0) {
				throw new BastionError('usage', `could not unpack the template: ${result.stderr}`, {
					next: null
				});
			}
		});
	await extract(archive, options.dest);
	ctx.files.remove(archive);
	return readTemplate(ctx, options.dest);
}
