import { describe, expect, it } from 'vitest';
import { memoryFiles } from '../../../src/host/files';

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
