import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderConfig } from '../../../src/capnp/generate';
import { modulesFrom, planSite } from '../../../src/capnp/plan';
import { defaultContext, type Context } from '../../../src/context';
import {
	ASSETS_MANIFEST,
	importsOf,
	installAssets,
	prepareBundle,
	readBoxVars,
	RESERVED_VARS,
	unpackBundle,
	unpackModules,
	VARS_FILE,
	verifyAssets,
	verifyBundleTree
} from '../../../src/deploy/bundle';
import { scriptedRunner } from '../../../src/host/exec';
import { memoryFiles, nodeFiles } from '../../../src/host/files';

const ENTRY = 'import a from"./a.wasm";import b from"./c.lock";export default{a,b}';
const GOOD: Record<string, string> = { 'site.js': ENTRY, 'a.wasm': 'w', 'c.lock': '{}' };

function ctxWith(seed: Record<string, string> = {}, runner = scriptedRunner()): Context {
	return { ...defaultContext(), files: memoryFiles(seed), runner };
}

const treeOf = (tree: Record<string, string>) =>
	Object.fromEntries(Object.entries(tree).map(([name, body]) => [`/b/${name}`, body]));

describe('importsOf', () => {
	it('reads from and bare imports, in either quote, and skips packages and dynamic imports', () => {
		expect(
			importsOf(
				'import a from"./x.wasm";import"./y.js";import q from \'./z.lock\';import z from"node:fs";import("./w.js")'
			)
		).toEqual(['./x.wasm', './y.js', './z.lock']);
	});
});

describe('unpackBundle', () => {
	it('waits for tar and resolves on exit 0', async () => {
		let finished = false;
		const runner = {
			...scriptedRunner(),
			run: async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				finished = true;
				return { code: 0, stdout: '', stderr: '' };
			}
		};
		await unpackBundle(ctxWith({}, runner), '/a.tgz', '/dest');
		expect(finished).toBe(true);
	});

	it('answers bundle_invalid with the reason tar gave on a non-zero exit', async () => {
		const runner = scriptedRunner({
			tar: { code: 2, stdout: '', stderr: 'not in gzip format' }
		});
		await expect(unpackBundle(ctxWith({}, runner), '/a.tgz', '/dest')).rejects.toMatchObject({
			code: 'bundle_invalid',
			message: expect.stringContaining('not in gzip format')
		});
	});

	it('falls back to the exit code when tar printed nothing', async () => {
		const runner = scriptedRunner({ tar: { code: 3, stdout: '', stderr: '' } });
		await expect(unpackBundle(ctxWith({}, runner), '/a.tgz', '/dest')).rejects.toThrow(
			'exit 3'
		);
	});
});

describe('verifyBundleTree', () => {
	it('returns the entry of a complete tree', () => {
		expect(verifyBundleTree(ctxWith(treeOf(GOOD)), '/b')).toBe('site.js');
	});

	it('refuses a tree with no module, and one with no entry', () => {
		expect(() => verifyBundleTree(ctxWith({ '/b/readme.md': 'x' }), '/b')).toThrow(
			expect.objectContaining({ code: 'bundle_invalid' })
		);
		expect(() => verifyBundleTree(ctxWith({ '/b/a.wasm': 'w' }), '/b')).toThrow(
			expect.objectContaining({ code: 'bundle_invalid' })
		);
	});

	it('refuses a stated main the tree lacks', () => {
		expect(() => verifyBundleTree(ctxWith(treeOf(GOOD)), '/b', 'main.js')).toThrow(
			expect.objectContaining({ code: 'bundle_invalid' })
		);
	});

	it('refuses an import with no module behind it, naming it', () => {
		const tree = treeOf({ ...GOOD, 'site.js': 'import a from"./gone.wasm"' });
		expect(() => verifyBundleTree(ctxWith(tree), '/b')).toThrow('./gone.wasm');
	});

	it('refuses an import of a file the box does not load, which modulesFrom skips', () => {
		const tree = treeOf({ ...GOOD, 'site.js': 'import a from"./data.zst"', 'data.zst': 'z' });
		expect(() => verifyBundleTree(ctxWith(tree), '/b')).toThrow('./data.zst');
	});
});

const checkBundle = async (ctx: Context, bundle: string, scratch: string) => {
	const prepared = await prepareBundle(ctx, bundle, scratch);
	prepared.discard();
	return prepared.entry;
};

describe('preparing a bundle', () => {
	it('unpacks an archive, verifies it and removes what it unpacked', async () => {
		const files = memoryFiles({ '/a.tgz': 'x' });
		const runner = scriptedRunner({
			tar: (args) => {
				for (const [name, body] of Object.entries(GOOD)) {
					files.writeText(`${args[args.indexOf('-C') + 1]}/${name}`, body);
				}
				return { code: 0, stdout: '', stderr: '' };
			}
		});
		const ctx = { ...defaultContext(), files, runner };
		expect(await checkBundle(ctx, '/a.tgz', '/scratch')).toBe('site.js');
		expect(files.exists('/scratch/site.js')).toBe(false);
	});

	it('removes the unpacked files when the tree fails the check', async () => {
		const files = memoryFiles({ '/a.tgz': 'x' });
		const runner = scriptedRunner({
			tar: (args) => {
				files.writeText(`${args[args.indexOf('-C') + 1]}/a.wasm`, 'w');
				return { code: 0, stdout: '', stderr: '' };
			}
		});
		const ctx = { ...defaultContext(), files, runner };
		await expect(checkBundle(ctx, '/a.tgz', '/scratch')).rejects.toMatchObject({
			code: 'bundle_invalid'
		});
		expect(files.exists('/scratch/a.wasm')).toBe(false);
	});

	it('verifies a directory in place, and refuses a path that is not there', async () => {
		const ctx = ctxWith(treeOf(GOOD));
		expect(await checkBundle(ctx, '/b', '/scratch')).toBe('site.js');
		await expect(checkBundle(ctx, '/nope.tgz', '/scratch')).rejects.toMatchObject({
			code: 'bundle_invalid'
		});
	});
});

describe('the lock module', () => {
	it('is listed as a module beside the entry, so workerd finds what site.js imports', () => {
		const names = modulesFrom(ctxWith(treeOf(GOOD)), '/b').map((module) => module.name);
		expect(names).toEqual(['site.js', 'a.wasm', 'c.lock']);
	});
});

const ASSETS = {
	'driver.json': '{"a":1}',
	'core/css/a.css': 'body{}',
	'drupal-pf/core.pf.bin': 'bin'
};
const sha = (body: string) => createHash('sha256').update(body).digest('hex');

function manifestOf(
	assets: Record<string, string>,
	edit: (files: Record<string, unknown>[]) => Record<string, unknown>[] = (files) => files
): string {
	const files = Object.entries(assets).map(([path, body]) => ({
		path: `assets/${path}`,
		bytes: body.length,
		sha256: sha(body)
	}));
	return JSON.stringify({
		name: 'drupflare-box-bundle',
		version: 1,
		release: '1.1.0',
		files: edit(files)
	});
}

/** a bundle folder holding the modules, the assets and, unless it is null, their manifest */
function withAssets(
	assets: Record<string, string> = ASSETS,
	manifest: string | null = manifestOf(assets)
): Record<string, string> {
	const tree: Record<string, string> = { ...treeOf(GOOD) };
	for (const [path, body] of Object.entries(assets)) tree[`/b/assets/${path}`] = body;
	if (manifest !== null) tree[`/b/${ASSETS_MANIFEST}`] = manifest;
	return tree;
}

describe('verifyAssets', () => {
	it('answers null for a bundle with neither a folder nor a manifest', () => {
		expect(verifyAssets(ctxWith(treeOf(GOOD)), '/b')).toBeNull();
	});

	it('lists the files of a tree that matches its manifest', () => {
		expect(verifyAssets(ctxWith(withAssets()), '/b')).toEqual([
			'core/css/a.css',
			'driver.json',
			'drupal-pf/core.pf.bin'
		]);
	});

	it('takes a folder with no manifest as it stands', () => {
		expect(verifyAssets(ctxWith(withAssets(ASSETS, null)), '/b')).toHaveLength(3);
	});

	it('refuses a corrupted file, naming it', () => {
		const tree = withAssets();
		tree['/b/assets/core/css/a.css'] = 'body{color:red}';
		expect(() => verifyAssets(ctxWith(tree), '/b')).toThrow(
			expect.objectContaining({
				code: 'bundle_invalid',
				message: expect.stringContaining('assets/core/css/a.css does not match')
			})
		);
	});

	it('refuses a file the manifest does not list', () => {
		const tree = withAssets();
		tree['/b/assets/extra.txt'] = 'x';
		expect(() => verifyAssets(ctxWith(tree), '/b')).toThrow('assets/extra.txt is not listed');
	});

	it('refuses a listed file the bundle does not hold', () => {
		const tree = withAssets();
		delete tree['/b/assets/driver.json'];
		expect(() => verifyAssets(ctxWith(tree), '/b')).toThrow(
			'assets/driver.json is listed and missing'
		);
	});

	it('refuses a manifest entry that names a path outside the assets folder', () => {
		for (const path of [
			'assets/../site.js',
			'assets/core/../../x',
			'../etc/passwd',
			'/etc/passwd',
			'site.js',
			'assets//a',
			'assets/./a',
			'assets/a\\b'
		]) {
			const tree = withAssets(
				ASSETS,
				manifestOf(ASSETS, (files) => [...files, { path, bytes: 1, sha256: sha('x') }])
			);
			expect(() => verifyAssets(ctxWith(tree), '/b'), path).toThrow(
				expect.objectContaining({ code: 'bundle_invalid' })
			);
		}
	});

	it('refuses an entry with a bad size or digest, a duplicate, and a manifest that is not one', () => {
		const bad = (edit: (files: Record<string, unknown>[]) => Record<string, unknown>[]) =>
			withAssets(ASSETS, manifestOf(ASSETS, edit));
		const first = (files: Record<string, unknown>[]) => files[0]!;
		const cases = [
			bad((files) => [{ ...first(files), bytes: 1.5 }, ...files.slice(1)]),
			bad((files) => [{ ...first(files), bytes: -1 }, ...files.slice(1)]),
			bad((files) => [{ ...first(files), sha256: 'ABC' }, ...files.slice(1)]),
			bad((files) => [...files, first(files)]),
			withAssets(ASSETS, 'not json'),
			withAssets(ASSETS, JSON.stringify({ name: 'other', version: 1, files: [] })),
			withAssets(
				ASSETS,
				JSON.stringify({ name: 'drupflare-box-bundle', version: 2, files: [] })
			),
			withAssets(ASSETS, JSON.stringify({ name: 'drupflare-box-bundle', version: 1 }))
		];
		for (const tree of cases) {
			expect(() => verifyAssets(ctxWith(tree), '/b')).toThrow(
				expect.objectContaining({ code: 'bundle_invalid' })
			);
		}
	});

	it('refuses a manifest that lists files when the bundle has no folder, and allows an empty one', () => {
		const tree = { ...treeOf(GOOD), [`/b/${ASSETS_MANIFEST}`]: manifestOf(ASSETS) };
		expect(() => verifyAssets(ctxWith(tree), '/b')).toThrow('no assets folder');
		tree[`/b/${ASSETS_MANIFEST}`] = manifestOf({});
		expect(verifyAssets(ctxWith(tree), '/b')).toBeNull();
	});

	it('refuses a file that resolves outside the folder, which a link out of it would', () => {
		const files = memoryFiles(withAssets());
		const ctx = {
			...defaultContext(),
			files: {
				...files,
				realpath: (path: string) => (path.endsWith('driver.json') ? '/etc/passwd' : path)
			}
		};
		expect(() => verifyAssets(ctx, '/b')).toThrow('assets/driver.json resolves outside');
	});

	it('refuses a file it cannot read', () => {
		const files = memoryFiles(withAssets());
		const ctx = {
			...defaultContext(),
			files: {
				...files,
				readBytes: (path: string) => {
					if (path.endsWith('a.css')) throw new Error('EISDIR');
					return files.readBytes(path);
				}
			}
		};
		expect(() => verifyAssets(ctx, '/b')).toThrow('assets/core/css/a.css could not be read');
	});
});

describe('installAssets', () => {
	const FILES = ['core/css/a.css', 'driver.json', 'drupal-pf/core.pf.bin'];
	const DEST = '/t/acme/assets';

	function placed(extra: Record<string, string> = {}) {
		return memoryFiles({ ...withAssets(), ...extra });
	}
	const ctxOf = (files: ReturnType<typeof memoryFiles>): Context => ({
		...defaultContext(),
		files
	});

	it('places every file with its bytes and leaves no sibling folder after commit', () => {
		const files = placed();
		const install = installAssets(ctxOf(files), '/b/assets', DEST, FILES);
		install.commit();
		for (const [path, body] of Object.entries(ASSETS)) {
			expect(files.readText(`${DEST}/${path}`)).toBe(body);
		}
		expect(files.exists(`${DEST}.incoming`)).toBe(false);
		expect(files.exists(`${DEST}.previous`)).toBe(false);
	});

	it('replaces what was there, and a rollback puts it back', () => {
		const files = placed({ [`${DEST}/old.txt`]: 'old' });
		const install = installAssets(ctxOf(files), '/b/assets', DEST, FILES);
		expect(files.exists(`${DEST}/old.txt`)).toBe(false);
		expect(files.readText(`${DEST}/driver.json`)).toBe(ASSETS['driver.json']);
		install.rollback();
		expect(files.readText(`${DEST}/old.txt`)).toBe('old');
		expect(files.exists(`${DEST}/driver.json`)).toBe(false);
		expect(files.exists(`${DEST}.previous`)).toBe(false);
	});

	it('leaves nothing where there was nothing when it is rolled back', () => {
		const files = placed();
		installAssets(ctxOf(files), '/b/assets', DEST, FILES).rollback();
		expect(files.exists(DEST)).toBe(false);
	});

	it('leaves the tenant as it was when a file cannot be placed', () => {
		const files = placed({ [`${DEST}/old.txt`]: 'old' });
		const ctx = {
			...ctxOf(files),
			files: {
				...files,
				link: (from: string, to: string) => {
					if (from.endsWith('driver.json')) throw new Error('ENOSPC');
					files.link(from, to);
				}
			}
		};
		expect(() => installAssets(ctx, '/b/assets', DEST, FILES)).toThrow(
			expect.objectContaining({
				code: 'assets_failed',
				message: expect.stringContaining('ENOSPC')
			})
		);
		expect(files.readText(`${DEST}/old.txt`)).toBe('old');
		expect(files.exists(`${DEST}/core/css/a.css`)).toBe(false);
		expect(files.exists(`${DEST}.incoming`)).toBe(false);
	});

	it('puts the old folder back when the swap itself fails', () => {
		const files = placed({ [`${DEST}/old.txt`]: 'old' });
		const ctx = {
			...ctxOf(files),
			files: {
				...files,
				rename: (from: string, to: string) => {
					if (from.endsWith('.incoming')) throw new Error('EXDEV');
					files.rename(from, to);
				}
			}
		};
		expect(() => installAssets(ctx, '/b/assets', DEST, FILES)).toThrow('EXDEV');
		expect(files.readText(`${DEST}/old.txt`)).toBe('old');
		expect(files.exists(`${DEST}.incoming`)).toBe(false);
	});

	it('restores a folder an earlier run set aside and never put back', () => {
		const files = placed({ [`${DEST}.previous/old.txt`]: 'old', [`${DEST}.incoming/x`]: 'x' });
		const install = installAssets(ctxOf(files), '/b/assets', DEST, FILES);
		install.rollback();
		expect(files.readText(`${DEST}/old.txt`)).toBe('old');
	});

	it('drops a stale set-aside folder when the live one is there', () => {
		const files = placed({ [`${DEST}.previous/stale.txt`]: 's', [`${DEST}/live.txt`]: 'l' });
		const install = installAssets(ctxOf(files), '/b/assets', DEST, FILES);
		install.rollback();
		expect(files.readText(`${DEST}/live.txt`)).toBe('l');
		expect(files.exists(`${DEST}/stale.txt`)).toBe(false);
	});
});

describe('prepareBundle', () => {
	function archiveCtx(tree: Record<string, string>) {
		const files = memoryFiles({ '/a.tgz': 'x' });
		const runner = scriptedRunner({
			tar: (args) => {
				for (const [path, body] of Object.entries(tree)) {
					files.writeText(`${args[args.indexOf('-C') + 1]}/${path}`, body);
				}
				return { code: 0, stdout: '', stderr: '' };
			}
		});
		return { files, ctx: { ...defaultContext(), files, runner } };
	}
	const rel = (tree: Record<string, string>) =>
		Object.fromEntries(Object.entries(tree).map(([k, v]) => [k.replace('/b/', ''), v]));

	it('hands back the unpacked assets and removes the scratch folder on discard', async () => {
		const { files, ctx } = archiveCtx(rel(withAssets()));
		const prepared = await prepareBundle(ctx, '/a.tgz', '/scratch');
		expect(prepared.entry).toBe('site.js');
		expect(prepared.assets?.dir).toBe('/scratch/assets');
		expect(prepared.assets?.files).toHaveLength(3);
		expect(files.exists('/scratch/assets/driver.json')).toBe(true);
		prepared.discard();
		expect(files.exists('/scratch')).toBe(false);
	});

	it('removes the scratch folder when the assets fail the check', async () => {
		const tree = rel(withAssets());
		tree['assets/driver.json'] = 'tampered';
		const { files, ctx } = archiveCtx(tree);
		await expect(prepareBundle(ctx, '/a.tgz', '/scratch')).rejects.toMatchObject({
			code: 'bundle_invalid'
		});
		expect(files.exists('/scratch')).toBe(false);
	});

	it('answers null assets for a bundle without any', async () => {
		const { ctx } = archiveCtx(rel(treeOf(GOOD)));
		expect((await prepareBundle(ctx, '/a.tgz', '/scratch')).assets).toBeNull();
	});

	it('never removes a bundle named as a folder', async () => {
		const files = memoryFiles(withAssets());
		const ctx = { ...defaultContext(), files };
		const prepared = await prepareBundle(ctx, '/b', '/scratch');
		expect(prepared.assets?.dir).toBe('/b/assets');
		prepared.discard();
		expect(files.exists('/b/site.js')).toBe(true);
		await expect(
			prepareBundle(
				{ ...ctx, files: memoryFiles({ ...withAssets(), '/b/assets/x': 'extra' }) },
				'/b',
				'/scratch'
			)
		).rejects.toMatchObject({ code: 'bundle_invalid' });
	});
});

describe('readBoxVars', () => {
	const read = (body: string | null) =>
		readBoxVars(ctxWith(body === null ? {} : { '/b/box.vars': body }), '/b/box.vars');

	it('answers null for a bundle with no vars file', () => {
		expect(read(null)).toBeNull();
	});

	it('stores strings, numbers and booleans as text', () => {
		expect(read('{"CMS":"drupal","N":4194304,"ON":true,"OFF":false,"Z":0}')).toEqual({
			CMS: 'drupal',
			N: '4194304',
			ON: 'true',
			OFF: 'false',
			Z: '0'
		});
	});

	it('keeps the order the file wrote, so a resend writes the same bindings', () => {
		expect(Object.keys(read('{"B":"1","A":"2","C":"3"}')!)).toEqual(['B', 'A', 'C']);
	});

	it('accepts an empty object', () => {
		expect(read('{}')).toEqual({});
	});

	it.each([
		['not json', 'CMS=drupal', 'not readable json'],
		['an array', '["a"]', 'not an object'],
		['null', 'null', 'not an object'],
		['a number', '3', 'not an object'],
		['a nested object', '{"A":{"b":1}}', 'not a string, number or boolean'],
		['a list value', '{"A":[1]}', 'not a string, number or boolean'],
		['a null value', '{"A":null}', 'not a string, number or boolean'],
		['a name with a dash', '{"A-B":"1"}', 'name a binding cannot have'],
		['a name starting with a digit', '{"1A":"1"}', 'name a binding cannot have'],
		['an empty name', '{"":"1"}', 'name a binding cannot have'],
		['a long name', `{"${'A'.repeat(65)}":"1"}`, 'name a binding cannot have'],
		['a long value', `{"A":"${'x'.repeat(4097)}"}`, 'is too long']
	])('refuses %s with bundle_invalid', (_, body, reason) => {
		expect(() => read(body)).toThrow(
			expect.objectContaining({
				code: 'bundle_invalid',
				message: expect.stringContaining(reason)
			})
		);
	});

	it.each(RESERVED_VARS)('refuses %s, which the box binds itself', (name) => {
		expect(() => read(`{"${name}":"x"}`)).toThrow(
			expect.objectContaining({
				code: 'bundle_invalid',
				message: expect.stringContaining(`sets ${name}`)
			})
		);
	});

	it('names the bindings the default drupflare shape gets', () => {
		expect([...RESERVED_VARS].sort()).toEqual(
			['ASSETS', 'CONFIG_KV', 'PAGE_KV', 'SITE', 'UNSAFE_EVAL'].sort()
		);
	});

	it('refuses a file over the size cap, and one with too many names', () => {
		const wide = JSON.stringify(
			Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`V${i}`, 'x']))
		);
		expect(() => read(wide)).toThrow(expect.objectContaining({ code: 'bundle_invalid' }));
		expect(() => read(`{"A":"${'x'.repeat(16 * 1024)}"}`)).toThrow('over 16384 bytes');
	});

	it('refuses a file it cannot read', () => {
		const files = memoryFiles({ '/b/box.vars': '{}' });
		files.readBytes = () => {
			throw new Error('EIO');
		};
		expect(() => readBoxVars({ ...defaultContext(), files }, '/b/box.vars')).toThrow(
			'could not be read'
		);
	});

	it('is not listed as a module, so workerd never embeds it', () => {
		const names = modulesFrom(ctxWith(treeOf({ ...GOOD, 'box.vars': '{}' })), '/b').map(
			(module) => module.name
		);
		expect(names).toEqual(['site.js', 'a.wasm', 'c.lock']);
		expect(VARS_FILE).toBe('box.vars');
	});
});

describe('a prepared bundle with vars', () => {
	function archiveCtx(tree: Record<string, string>) {
		const files = memoryFiles({ '/a.tgz': 'x' });
		const runner = scriptedRunner({
			tar: (args) => {
				for (const [path, body] of Object.entries(tree)) {
					files.writeText(`${args[args.indexOf('-C') + 1]}/${path}`, body);
				}
				return { code: 0, stdout: '', stderr: '' };
			}
		});
		return { files, ctx: { ...defaultContext(), files, runner } };
	}
	const GOOD_TREE = { 'site.js': ENTRY, 'a.wasm': 'w', 'c.lock': '{}' };

	it('names the vars file when the bundle carries one, and null when it does not', async () => {
		const held = archiveCtx({ ...GOOD_TREE, 'box.vars': '{"CMS":"drupal"}' });
		const prepared = await prepareBundle(held.ctx, '/a.tgz', '/scratch');
		expect(prepared.varsFile).toBe('/scratch/box.vars');
		prepared.discard();
		const bare = archiveCtx(GOOD_TREE);
		expect((await prepareBundle(bare.ctx, '/a.tgz', '/scratch')).varsFile).toBeNull();
	});

	it('refuses a malformed vars file and removes the scratch folder', async () => {
		const { files, ctx } = archiveCtx({ ...GOOD_TREE, 'box.vars': '[1]' });
		await expect(prepareBundle(ctx, '/a.tgz', '/scratch')).rejects.toMatchObject({
			code: 'bundle_invalid'
		});
		expect(files.exists('/scratch')).toBe(false);
	});
});

describe('unpackModules', () => {
	function listing(stdout: string, extractCode = 0) {
		const calls: string[][] = [];
		const runner = scriptedRunner({
			tar: (args) => {
				calls.push(args);
				return args[0] === '-tzf'
					? { code: 0, stdout, stderr: '' }
					: { code: extractCode, stdout: '', stderr: 'bad member' };
			}
		});
		return {
			calls,
			ctx: ctxWith({ '/dest/stale.wasm': 'old', '/dest/assets/x': 'old' }, runner)
		};
	}

	it('extracts only the files at the root, by name', async () => {
		const { calls, ctx } = listing(
			'assets/\nassets/a.css\nassets/core/b.js\nsite.js\na.wasm\nbox.vars\nassets.manifest\n'
		);
		await unpackModules(ctx, '/a.tgz', '/dest');
		expect(calls[1]).toEqual([
			'-xzf',
			'/a.tgz',
			'-C',
			'/dest',
			'--',
			'site.js',
			'a.wasm',
			'box.vars',
			'assets.manifest'
		]);
	});

	it('reads a ./ prefix as the root, and skips ./ itself and folders', async () => {
		const { calls, ctx } = listing('./\n./site.js\n./sub/\n./sub/x.js\n./assets/a.css\n');
		await unpackModules(ctx, '/a.tgz', '/dest');
		expect(calls[1]?.slice(5)).toEqual(['./site.js']);
	});

	it('empties the folder first, so a module an older release held does not stay', async () => {
		const { ctx } = listing('site.js\n');
		await unpackModules(ctx, '/a.tgz', '/dest');
		expect(ctx.files.exists('/dest/stale.wasm')).toBe(false);
		expect(ctx.files.exists('/dest/assets/x')).toBe(false);
	});

	it('extracts nothing for an archive with no root files, rather than everything', async () => {
		const { calls, ctx } = listing('assets/\nassets/a.css\n');
		await unpackModules(ctx, '/a.tgz', '/dest');
		expect(calls).toHaveLength(1);
		expect(ctx.files.isDirectory('/dest')).toBe(true);
	});

	it('answers bundle_invalid when the listing or the extraction fails', async () => {
		const failing = scriptedRunner({
			tar: { code: 2, stdout: '', stderr: 'not in gzip format' }
		});
		await expect(unpackModules(ctxWith({}, failing), '/a.tgz', '/dest')).rejects.toMatchObject({
			code: 'bundle_invalid',
			message: expect.stringContaining('not in gzip format')
		});
		const { ctx } = listing('site.js\n', 2);
		await expect(unpackModules(ctx, '/a.tgz', '/dest')).rejects.toMatchObject({
			code: 'bundle_invalid',
			message: expect.stringContaining('bad member')
		});
	});

	it('falls back to the exit code when tar printed nothing', async () => {
		const runner = scriptedRunner({ tar: { code: 3, stdout: '', stderr: '' } });
		await expect(unpackModules(ctxWith({}, runner), '/a.tgz', '/dest')).rejects.toThrow(
			'exit 3'
		);
	});
});

describe('the assets manifest', () => {
	it('is not listed as a module, so workerd never embeds it', () => {
		const names = modulesFrom(ctxWith(withAssets()), '/b').map((module) => module.name);
		expect(names).toEqual(['site.js', 'a.wasm', 'c.lock']);
	});
});

/**
 * Runs the real box bundle through the same readers a box uses when
 * `BOX_BUNDLE_ARCHIVE` names one (built with `scripts/build-box-bundle.ts` in the worker repo);
 * without it the spec has nothing to read and skips.
 */
describe.skipIf(!process.env['BOX_BUNDLE_ARCHIVE'])('a real box bundle', () => {
	it('unpacks, verifies and generates a workerd config naming every module', async () => {
		const archive = process.env['BOX_BUNDLE_ARCHIVE']!;
		expect(existsSync(archive)).toBe(true);
		const scratch = mkdtempSync(join(tmpdir(), 'real-box-'));
		try {
			const ctx = { ...defaultContext(), files: nodeFiles() };
			const prepared = await prepareBundle(ctx, archive, join(scratch, '.check'));
			expect(prepared.entry).toBe('site.js');
			expect(prepared.assets?.files.length).toBeGreaterThan(1000);
			expect(prepared.varsFile).not.toBeNull();
			expect(readBoxVars(ctx, prepared.varsFile!)).toMatchObject({ CMS: 'drupal' });
			prepared.discard();
			await unpackModules(ctx, archive, join(scratch, 'lean'));
			expect(existsSync(join(scratch, 'lean', 'assets'))).toBe(false);
			expect(existsSync(join(scratch, 'lean', 'site.js'))).toBe(true);
			await unpackBundle(ctx, archive, join(scratch, 'bundle'));
			const modules = modulesFrom(ctx, join(scratch, 'bundle'), undefined, scratch);
			const listed = execFileSync('tar', ['-tzf', archive], {
				encoding: 'utf8',
				maxBuffer: 1 << 26
			})
				.trim()
				.split('\n')
				.filter(
					(name) => !name.includes('/') && !['assets.manifest', 'box.vars'].includes(name)
				);
			expect(modules.map((module) => module.name).sort()).toEqual(listed.sort());
			const rendered = renderConfig(
				planSite({
					tenant: { name: 'acme', sites: [] },
					site: { host: 'www.example.edu', bundle: archive },
					paths: {
						bundle: join(scratch, 'bundle'),
						storage: join(scratch, 'storage'),
						assets: join(scratch, 'assets'),
						adapterDir: '/tmp/a',
						listenSocket: '/tmp/a/http.sock'
					},
					modules,
					compatibilityDate: '2026-08-01',
					compatibilityFlags: ['nodejs_compat'],
					uniqueKey: 'acme:www.example.edu',
					durableObjectClass: 'SitePhpDurableObject',
					residency: 'evict',
					bindings: {
						durableObject: 'SITE',
						assets: 'ASSETS',
						kv: ['CONFIG_KV', 'PAGE_KV']
					},
					vars: {}
				})
			);
			for (const module of modules) expect(rendered).toContain(module.name);
			const lean = modulesFrom(ctx, join(scratch, 'lean'), undefined, scratch);
			expect(lean.map((module) => module.name).sort()).toEqual(
				modules.map((module) => module.name).sort()
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}, 60_000);
});
