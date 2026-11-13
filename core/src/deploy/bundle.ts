import { modulesFrom } from '../capnp/plan';
import { DEFAULT_SITE_WORKER } from '../config/defaults';
import type { Context } from '../context';
import { BastionError } from '../errors';
import { sha256Of } from '../update/pin';

export const BUNDLE_INVALID = 'bundle_invalid';

function invalid(message: string): BastionError {
	return new BastionError(BUNDLE_INVALID, message, { next: null, retryable: false });
}

/**
 * Unpacks a gzipped tar into `dest` and waits for it.
 *
 * `runner.run` is asynchronous (it wraps `execFile`), so a caller that does not await it reads a
 * half-written tree. A non-zero exit is a bundle that cannot be used, never a partial success.
 */
export async function unpackBundle(ctx: Context, archive: string, dest: string): Promise<void> {
	ctx.files.mkdirp(dest);
	const result = await ctx.runner.run('tar', ['-xzf', archive, '-C', dest]);
	if (result.code !== 0) {
		throw invalid(
			`could not unpack ${archive}: ${result.stderr.trim() || `exit ${result.code}`}`
		);
	}
}

/**
 * Unpacks only the files at the archive root into `dest`, and waits for it.
 *
 * What a start reads is the modules, which sit at the top level. `site.add` has already placed the
 * `assets/` tree in the tenant's state, so extracting it again on every start only copies thousands
 * of files. The members are named from `tar -t` and not filtered with `--exclude`, whose matching
 * differs between GNU tar and bsdtar. A start that follows an older one finds the folder emptied
 * first, so a module a release dropped does not stay behind.
 */
export async function unpackModules(ctx: Context, archive: string, dest: string): Promise<void> {
	ctx.files.removeTree(dest);
	ctx.files.mkdirp(dest);
	const listed = await ctx.runner.run('tar', ['-tzf', archive]);
	if (listed.code !== 0) {
		throw invalid(
			`could not read ${archive}: ${listed.stderr.trim() || `exit ${listed.code}`}`
		);
	}
	const names = listed.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter(
			(line) => line !== '' && !line.endsWith('/') && !line.replace(/^\.\//, '').includes('/')
		);
	if (names.length === 0) return;
	const result = await ctx.runner.run('tar', ['-xzf', archive, '-C', dest, '--', ...names]);
	if (result.code !== 0) {
		throw invalid(
			`could not unpack ${archive}: ${result.stderr.trim() || `exit ${result.code}`}`
		);
	}
}

/** the relative modules a script names in an import, as `./x` strings */
export function importsOf(source: string): string[] {
	const found = new Set<string>();
	for (const match of source.matchAll(/(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+)["']/g)) {
		found.add(match[1] as string);
	}
	return [...found].sort();
}

/**
 * Refuses an unpacked tree that workerd could not start.
 *
 * `modulesFrom` is the reader `up` uses, so asking it here means the answer cannot differ from the
 * one the next reload gives. On top of it, every module the entry imports by relative name has to
 * be one of the modules it listed: a file it skips (a nested folder, an ending it does not load)
 * would otherwise be found missing by workerd at start.
 */
export function verifyBundleTree(ctx: Context, dir: string, main?: string): string {
	let modules;
	try {
		modules = modulesFrom(ctx, dir, main);
	} catch (error) {
		if (error instanceof BastionError) throw invalid(error.message);
		throw error;
	}
	const entry = modules[0]!;
	const names = new Set(modules.map((module) => module.name));
	const source = ctx.files.readText(`${dir}/${entry.name}`);
	for (const specifier of importsOf(source)) {
		const name = specifier.replace(/^\.\//, '');
		if (specifier.startsWith('../') || name.includes('/') || !names.has(name)) {
			throw invalid(`${entry.name} imports ${specifier} and the bundle has no such module`);
		}
	}
	return entry.name;
}

// #region assets

/** the file at the bundle root that lists the asset tree; it has no ending a module is loaded from */
export const ASSETS_MANIFEST = 'assets.manifest';

const SHA256 = /^[0-9a-f]{64}$/;

export interface AssetEntry {
	path: string;
	bytes: number;
	sha256: string;
}

/** the path under `assets/` that an entry names, or null for one that could leave the folder */
function assetPathOf(path: unknown): string | null {
	if (typeof path !== 'string' || !path.startsWith('assets/') || /[\\\0]/.test(path)) return null;
	const rest = path.slice('assets/'.length);
	const segments = rest.split('/');
	return segments.some((part) => part === '' || part === '.' || part === '..') ? null : rest;
}

function manifestEntries(ctx: Context, path: string): AssetEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(ctx.files.readText(path));
	} catch {
		throw invalid(`${ASSETS_MANIFEST} is not readable json`);
	}
	const held = parsed as { name?: unknown; version?: unknown; files?: unknown } | null;
	if (held?.name !== 'drupflare-box-bundle' || held.version !== 1 || !Array.isArray(held.files)) {
		throw invalid(`${ASSETS_MANIFEST} is not a box bundle manifest`);
	}
	return held.files.map((entry: Record<string, unknown>) => {
		if (
			assetPathOf(entry?.path) === null ||
			!Number.isSafeInteger(entry.bytes) ||
			(entry.bytes as number) < 0 ||
			typeof entry.sha256 !== 'string' ||
			!SHA256.test(entry.sha256)
		) {
			throw invalid(`${ASSETS_MANIFEST} holds an entry a box does not accept`);
		}
		return entry as unknown as AssetEntry;
	});
}

/** every file under `dir` as a path relative to it, sorted; a link is a file, never followed */
function filesUnder(ctx: Context, dir: string, prefix = ''): string[] {
	const found: string[] = [];
	for (const entry of ctx.files.readDir(dir)) {
		const rel = `${prefix}${entry.name}`;
		if (entry.directory) found.push(...filesUnder(ctx, `${dir}/${entry.name}`, `${rel}/`));
		else found.push(rel);
	}
	return found.sort();
}

/**
 * Checks the `assets/` folder of an unpacked bundle against its `assets.manifest`.
 *
 * Without a folder and without a manifest there is nothing to check and the answer is null. With a
 * manifest, the folder and the manifest have to name the same files, every file has to be a real
 * file inside the folder, and its size and sha-256 have to match. A bundle that carries a folder
 * and no manifest is taken as it stands, since nothing states what it should hold.
 *
 * @returns the files under `assets/`, relative to it
 */
export function verifyAssets(ctx: Context, dir: string): string[] | null {
	const root = `${dir}/assets`;
	const manifest = `${dir}/${ASSETS_MANIFEST}`;
	const hasTree = ctx.files.isDirectory(root);
	const hasManifest = ctx.files.exists(manifest);
	if (!hasTree && !hasManifest) return null;

	const entries = hasManifest ? manifestEntries(ctx, manifest) : null;
	if (!hasTree) {
		if (entries !== null && entries.length > 0) {
			throw invalid(`${ASSETS_MANIFEST} lists files and the bundle has no assets folder`);
		}
		return null;
	}

	const files = filesUnder(ctx, root);
	const realRoot = ctx.files.realpath(root);
	for (const file of files) {
		if (!ctx.files.realpath(`${root}/${file}`).startsWith(`${realRoot}/`)) {
			throw invalid(`assets/${file} resolves outside the assets folder`);
		}
	}
	if (entries === null) return files;

	const listed = new Map<string, AssetEntry>();
	for (const entry of entries) {
		const rel = assetPathOf(entry.path) as string;
		if (listed.has(rel)) throw invalid(`${ASSETS_MANIFEST} lists assets/${rel} twice`);
		listed.set(rel, entry);
	}
	const present = new Set(files);
	for (const file of files) {
		if (!listed.has(file)) throw invalid(`assets/${file} is not listed in ${ASSETS_MANIFEST}`);
	}
	for (const rel of listed.keys()) {
		if (!present.has(rel)) throw invalid(`assets/${rel} is listed and missing from the bundle`);
	}
	for (const [rel, entry] of listed) {
		let bytes: Uint8Array;
		try {
			bytes = ctx.files.readBytes(`${root}/${rel}`);
		} catch {
			throw invalid(`assets/${rel} could not be read`);
		}
		if (bytes.byteLength !== entry.bytes || sha256Of(bytes) !== entry.sha256) {
			throw invalid(`assets/${rel} does not match ${ASSETS_MANIFEST}`);
		}
	}
	return files;
}

/** where a tenant's static files live; the runtime serves this folder */
export function tenantAssets(state: string, tenant: string): string {
	return `${state}/tenants/${tenant}/assets`;
}

/** a placed asset tree that can still be undone */
export interface AssetInstall {
	/** keeps the new tree and drops the one it replaced */
	commit(): void;
	/** puts the old tree back and drops the new one */
	rollback(): void;
}

/**
 * Places `files` from `from` as the folder `dest`, replacing what is there.
 *
 * The files are linked into a sibling folder first and the folder is swapped in with two renames,
 * so a failure while placing leaves `dest` as it was. What it replaced stays beside it until
 * `commit`, so a step that fails after this one can still call `rollback`. A leftover folder from
 * an earlier run that stopped between the renames is put back first.
 */
export function installAssets(
	ctx: Context,
	from: string,
	dest: string,
	files: string[]
): AssetInstall {
	const incoming = `${dest}.incoming`;
	const previous = `${dest}.previous`;
	ctx.files.removeTree(incoming);
	if (ctx.files.exists(previous)) {
		if (ctx.files.exists(dest)) ctx.files.removeTree(previous);
		else ctx.files.rename(previous, dest);
	}
	try {
		ctx.files.mkdirp(incoming);
		for (const file of files) ctx.files.link(`${from}/${file}`, `${incoming}/${file}`);
		const held = ctx.files.exists(dest);
		if (held) ctx.files.rename(dest, previous);
		try {
			ctx.files.rename(incoming, dest);
		} catch (error) {
			if (held) ctx.files.rename(previous, dest);
			throw error;
		}
		return {
			commit: () => ctx.files.removeTree(previous),
			rollback: () => {
				ctx.files.removeTree(dest);
				if (ctx.files.exists(previous)) ctx.files.rename(previous, dest);
			}
		};
	} catch (error) {
		ctx.files.removeTree(incoming);
		throw new BastionError(
			'assets_failed',
			`could not place the assets: ${error instanceof Error ? error.message : String(error)}`,
			{ next: null, retryable: true }
		);
	}
}

// #endregion

// #region vars

/** the file at the bundle root that holds the worker's vars; it has no ending a module loads from */
export const VARS_FILE = 'box.vars';

const MAX_VARS_BYTES = 16 * 1024;
const MAX_VARS = 64;
const MAX_VALUE_LENGTH = 4096;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** names the box sets as bindings itself, which a var of the same name would collide with */
export const RESERVED_VARS: readonly string[] = [
	DEFAULT_SITE_WORKER.durableObject,
	DEFAULT_SITE_WORKER.assets,
	...DEFAULT_SITE_WORKER.kv,
	'UNSAFE_EVAL'
];

/**
 * Reads the vars file of an unpacked bundle, or null when the bundle carries none.
 *
 * A flat object of strings, numbers and booleans, at most 16 KiB and 64 names, with names a
 * workerd binding can have and none the box sets itself. A number or boolean is stored as its
 * text, since a site's bindings are text. Anything else is `bundle_invalid`, so a malformed file
 * is refused before the add writes a line.
 */
export function readBoxVars(ctx: Context, path: string): Record<string, string> | null {
	if (!ctx.files.exists(path)) return null;
	let bytes: Uint8Array;
	try {
		bytes = ctx.files.readBytes(path);
	} catch {
		throw invalid(`${VARS_FILE} could not be read`);
	}
	if (bytes.byteLength > MAX_VARS_BYTES) {
		throw invalid(`${VARS_FILE} is over ${MAX_VARS_BYTES} bytes`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw invalid(`${VARS_FILE} is not readable json`);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw invalid(`${VARS_FILE} is not an object`);
	}
	const entries = Object.entries(parsed);
	if (entries.length > MAX_VARS) throw invalid(`${VARS_FILE} holds more than ${MAX_VARS} names`);
	const vars: Record<string, string> = {};
	for (const [name, value] of entries) {
		if (!VAR_NAME.test(name)) throw invalid(`${VARS_FILE} has a name a binding cannot have`);
		if (RESERVED_VARS.includes(name))
			throw invalid(`${VARS_FILE} sets ${name}, which a box sets`);
		if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
			throw invalid(`${VARS_FILE} value for ${name} is not a string, number or boolean`);
		}
		const text = String(value);
		if (text.length > MAX_VALUE_LENGTH)
			throw invalid(`${VARS_FILE} value for ${name} is too long`);
		vars[name] = text;
	}
	return vars;
}

// #endregion

/** a bundle read and checked, with its asset tree when it carries one */
export interface PreparedBundle {
	entry: string;
	assets: { dir: string; files: string[] } | null;
	/** the vars file inside the unpacked bundle, or null when the bundle has none */
	varsFile: string | null;
	/** removes what was unpacked; a bundle named as a directory is never touched */
	discard(): void;
}

/**
 * Reads a bundle named as a directory or an archive, and refuses one a box could not run.
 *
 * An archive is unpacked into `scratch` and the caller discards it when done, pass or fail. A
 * refusal discards it here.
 */
export async function prepareBundle(
	ctx: Context,
	bundle: string,
	scratch: string,
	main?: string
): Promise<PreparedBundle> {
	if (!ctx.files.exists(bundle)) throw invalid(`there is no bundle at ${bundle}`);
	const isDirectory = ctx.files.isDirectory(bundle);
	const dir = isDirectory ? bundle : scratch;
	const discard = () => {
		if (!isDirectory) ctx.files.removeTree(scratch);
	};
	try {
		if (!isDirectory) {
			ctx.files.removeTree(scratch);
			await unpackBundle(ctx, bundle, scratch);
		}
		const entry = verifyBundleTree(ctx, dir, main);
		const files = verifyAssets(ctx, dir);
		const varsFile = `${dir}/${VARS_FILE}`;
		const held = readBoxVars(ctx, varsFile) !== null;
		return {
			entry,
			assets: files === null ? null : { dir: `${dir}/assets`, files },
			varsFile: held ? varsFile : null,
			discard
		};
	} catch (error) {
		discard();
		throw error;
	}
}
