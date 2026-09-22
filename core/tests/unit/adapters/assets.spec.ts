import { describe, expect, it } from 'vitest';
import { ASSET_PROFILES, assetResolver, compileIgnore } from '../../../src/adapters/assets';
import { memoryFiles } from '../../../src/host/files';

const ROOT = '/srv/assets';

const files = () =>
	memoryFiles({
		[`${ROOT}/core/style.css`]: 'body{}',
		[`${ROOT}/core/app.js`]: 'x',
		[`${ROOT}/logo.png`]: new Uint8Array([137, 80]),
		[`${ROOT}/drupal/site.sqlite`]: new Uint8Array([1, 2, 3]),
		[`${ROOT}/drupal/site.sqlite-wal`]: new Uint8Array([4]),
		[`${ROOT}/.env`]: 'SECRET=1',
		[`${ROOT}/private/notes.txt`]: 'hi',
		[`${ROOT}/README`]: 'no extension',
		'/srv/outside.css': 'nope'
	});

const resolver = (ignore?: string) => {
	const f = files();
	if (ignore !== undefined) f.writeText(`${ROOT}/.assetsignore`, ignore);
	return assetResolver(f, ROOT, ASSET_PROFILES.drupflare);
};

describe('the floor, which no ignore file can open', () => {
	// the smoke lane served this exact path publicly: the whole site database
	it('never serves a site database', async () => {
		expect(await resolver()('/drupal/site.sqlite')).toBe(null);
	});

	it('never serves its wal or shm either', async () => {
		expect(await resolver()('/drupal/site.sqlite-wal')).toBe(null);
	});

	it('never serves a dotfile', async () => {
		expect(await resolver()('/.env')).toBe(null);
	});

	it('holds even when the ignore file explicitly allows it', async () => {
		// an ignore file is a deny list; it cannot grant
		expect(await resolver('# nothing ignored\n')('/drupal/site.sqlite')).toBe(null);
	});
});

describe('serving', () => {
	it('serves a stylesheet with a real content type, not octet-stream', async () => {
		const found = await resolver()('/core/style.css');
		expect(found?.contentType).toBe('text/css; charset=utf-8');
	});

	it('serves an image as bytes', async () => {
		const found = await resolver()('/logo.png');
		expect(found?.contentType).toBe('image/png');
		expect(found?.bytes.length).toBe(2);
	});

	// guessing a type is how a database becomes a download
	it('refuses a file whose extension it does not know', async () => {
		expect(await resolver()('/README')).toBe(null);
	});

	it('answers null for an absent path', async () => {
		expect(await resolver()('/nope.css')).toBe(null);
	});
});

describe('path traversal', () => {
	// containment is checked after resolving, rather than by filtering the input
	it('refuses an escape with ..', async () => {
		expect(await resolver()('/../outside.css')).toBe(null);
		expect(await resolver()('/core/../../outside.css')).toBe(null);
	});

	it('still serves a path that merely contains dots', async () => {
		expect(await resolver()('/core/style.css')).not.toBe(null);
	});
});

describe('the ignore list', () => {
	it('hides an exact path', async () => {
		expect(await resolver('/private/notes.txt\n')('/private/notes.txt')).toBe(null);
	});

	it('hides a directory', async () => {
		expect(await resolver('/private/\n')('/private/notes.txt')).toBe(null);
	});

	it('hides by glob within a segment', async () => {
		expect(await resolver('/core/*.js\n')('/core/app.js')).toBe(null);
		expect(await resolver('/core/*.js\n')('/core/style.css')).not.toBe(null);
	});

	it('ignores comments and blank lines', async () => {
		const r = resolver('# a comment\n\n/private/\n');
		expect(await r('/core/style.css')).not.toBe(null);
		expect(await r('/private/notes.txt')).toBe(null);
	});
});

describe('compileIgnore', () => {
	it('matches across segments with a double star', () => {
		const [rule] = compileIgnore('/a/**/c');
		expect(rule?.test('/a/b/c')).toBe(true);
		expect(rule?.test('/a/b/d/c')).toBe(true);
	});

	// a deny list that matches a directory must also deny what is under it, so `/a/*` covering
	// `/a/b/c` is the safe reading rather than a leaky star. The star itself still does not cross
	// a segment: `/a/*` matches nothing outside `/a`.
	it('denies what is under a path it matched', () => {
		const [rule] = compileIgnore('/a/*');
		expect(rule?.test('/a/b')).toBe(true);
		expect(rule?.test('/a/b/c')).toBe(true);
		expect(rule?.test('/other/b')).toBe(false);
	});
});
