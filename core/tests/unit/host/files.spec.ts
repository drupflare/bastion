import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryFiles, nodeFiles } from '../../../src/host/files';

describe('memoryFiles', () => {
	it('holds bytes, so size and readBytes agree for a binary member', () => {
		const files = memoryFiles({ '/bin': new Uint8Array([0xff, 0x00, 0xfe]) });
		expect(files.size('/bin')).toBe(3);
		expect(Array.from(files.readBytes('/bin'))).toEqual([0xff, 0x00, 0xfe]);
	});

	it('raises for a path that is not there rather than answering empty', () => {
		expect(() => memoryFiles().readText('/nope')).toThrow(/ENOENT/);
		expect(() => memoryFiles().readBytes('/nope')).toThrow(/ENOENT/);
		expect(() => memoryFiles().size('/nope')).toThrow(/ENOENT/);
	});

	it('reports a mode only for a path that exists', () => {
		const files = memoryFiles({ '/a': 'x' });
		expect(files.mode('/a')).toBe(0o644);
		expect(files.mode('/nope')).toBe(null);
		files.chmod('/a', 0o600);
		expect(files.mode('/a')).toBe(0o600);
	});
});

describe('directory bookkeeping', () => {
	it('creates every missing ancestor, not only the nearest one', () => {
		const files = memoryFiles();
		files.mkdirp('/a/b/c');
		files.mkdirp('/a/b/c/d');
		expect(files.exists('/a')).toBe(true);
		expect(files.exists('/a/b')).toBe(true);
		expect(files.readDir('/a').map((e) => e.name)).toEqual(['b']);
	});

	it('lists a directory created only as the parent of a written file', () => {
		const files = memoryFiles();
		files.writeText('/certs/www.example.edu/key.pem', 'x');
		expect(files.readDir('/certs')).toEqual([{ name: 'www.example.edu', directory: true }]);
	});

	it('removes a file and forgets it', () => {
		const files = memoryFiles({ '/a': 'x' });
		files.remove('/a');
		expect(files.exists('/a')).toBe(false);
	});

	it('treats removing something absent as done rather than as an error', () => {
		expect(() => memoryFiles().remove('/nope')).not.toThrow();
	});
});

describe('trees', () => {
	const seed = { '/t/a/x.txt': 'x', '/t/a/b/y.txt': 'y', '/t/z.txt': 'z', '/ta/keep.txt': 'k' };

	it('removes a folder with everything under it and nothing that shares its prefix', () => {
		const files = memoryFiles(seed);
		files.removeTree('/t/a');
		expect(files.exists('/t/a')).toBe(false);
		expect(files.exists('/t/a/b')).toBe(false);
		expect(files.exists('/t/a/b/y.txt')).toBe(false);
		expect(files.exists('/t/z.txt')).toBe(true);
		expect(files.exists('/ta/keep.txt')).toBe(true);
	});

	it('removes a single file and treats an absent path as done', () => {
		const files = memoryFiles(seed);
		files.removeTree('/t/z.txt');
		expect(files.exists('/t/z.txt')).toBe(false);
		expect(() => files.removeTree('/nope')).not.toThrow();
	});

	it('moves a folder with its files, folders and modes', () => {
		const files = memoryFiles(seed);
		files.chmod('/t/a/x.txt', 0o600);
		files.rename('/t/a', '/u/moved');
		expect(files.exists('/t/a')).toBe(false);
		expect(files.readText('/u/moved/b/y.txt')).toBe('y');
		expect(files.isDirectory('/u/moved/b')).toBe(true);
		expect(files.mode('/u/moved/x.txt')).toBe(0o600);
		expect(files.exists('/t/z.txt')).toBe(true);
	});

	it('refuses to move what is not there and to move onto what is', () => {
		const files = memoryFiles(seed);
		expect(() => files.rename('/nope', '/u')).toThrow(/ENOENT/);
		expect(() => files.rename('/t/a', '/t/z.txt')).toThrow(/EEXIST/);
	});
});

describe('trees on a real disk', () => {
	it('removes and moves folders the way the memory host does', () => {
		const dir = mkdtempSync(join(tmpdir(), 'files-'));
		try {
			const files = nodeFiles();
			files.writeText(`${dir}/t/a/b/y.txt`, 'y');
			files.rename(`${dir}/t/a`, `${dir}/u/moved`);
			expect(files.readText(`${dir}/u/moved/b/y.txt`)).toBe('y');
			expect(files.exists(`${dir}/t/a`)).toBe(false);
			files.removeTree(`${dir}/u`);
			expect(files.exists(`${dir}/u`)).toBe(false);
			expect(() => files.removeTree(`${dir}/u`)).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
