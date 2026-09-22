import { describe, expect, it } from 'vitest';
import { configPath, loadConfig, type ConfigHost } from '../../../src/config/file';
import { memoryFiles } from '../../../src/host/files';

const host = (seed: Record<string, string>, env: NodeJS.ProcessEnv = {}): ConfigHost => ({
	files: memoryFiles(seed),
	env,
	cwd: '/srv'
});

const good = `
version: 1
mode: solo
state: /var/lib/bastion
tenants:
  - name: acme
    sites:
      - host: www.example.edu
        bundle: ./payload.tar.gz
`;

describe('configPath', () => {
	it('prefers an explicit path, resolved against cwd', () => {
		expect(configPath(host({}), 'x.yml')).toBe('/srv/x.yml');
		expect(configPath(host({}), '/etc/b.yml')).toBe('/etc/b.yml');
	});

	it('then the environment', () => {
		expect(configPath(host({}, { BASTION_CONFIG: '/env/b.yml' }))).toBe('/env/b.yml');
	});

	it('then a file in the working directory', () => {
		expect(configPath(host({ '/srv/bastion.yml': good }))).toBe('/srv/bastion.yml');
	});

	it('then the system path, even when nothing is there', () => {
		expect(configPath(host({}))).toBe('/etc/bastion/bastion.yml');
	});
});

describe('loadConfig', () => {
	it('returns defaults when no file exists and none was required', () => {
		const loaded = loadConfig(host({}));
		expect(loaded.path).toBe(null);
		expect(loaded.config.mode).toBe('solo');
		expect(loaded.config.runtime.limits.isolateMemory).toBe(128 * 1024 * 1024);
	});

	it('raises when a file was required and is absent', () => {
		expect(() => loadConfig(host({}), { required: true })).toThrow(/no bastion.yml/);
	});

	it('merges a file over the defaults', () => {
		const loaded = loadConfig(host({ '/srv/bastion.yml': good }));
		expect(loaded.path).toBe('/srv/bastion.yml');
		expect(loaded.config.tenants).toHaveLength(1);
		expect(loaded.config.tenants[0]?.sites[0]?.host).toBe('www.example.edu');
		// untouched keys still carry their defaults
		expect(loaded.config.front.http3).toBe(false);
		expect(loaded.config.runtime.residency).toBe('evict');
	});

	// treating a broken file as no config would silently drop every setting in it
	it('raises on unparseable YAML rather than falling back to defaults', () => {
		expect(() => loadConfig(host({ '/srv/bastion.yml': 'a: [1,\n  b: 2' }))).toThrow(
			/not valid YAML/
		);
	});

	it('raises on a document that is not a mapping', () => {
		expect(() => loadConfig(host({ '/srv/bastion.yml': '- 1\n- 2\n' }))).toThrow(
			/must hold a mapping/
		);
	});

	it('raises with the path of every rejection', () => {
		const bad = 'version: 1\nmode: yolo\nlogs:\n  level: chatty\n';
		expect(() => loadConfig(host({ '/srv/bastion.yml': bad }))).toThrow(/mode: must be one of/);
		expect(() => loadConfig(host({ '/srv/bastion.yml': bad }))).toThrow(/logs.level/);
	});

	it('records which keys the FILE set, so a report can attribute each one', () => {
		const loaded = loadConfig(host({ '/srv/bastion.yml': good }));
		expect(loaded.origins.get('mode')?.origin).toBe('file');
		expect(loaded.origins.get('mode')?.from).toBe('/srv/bastion.yml');
		// a key the file never mentioned is absent, so it reads as a default rather than as set
		expect(loaded.origins.has('front.http3')).toBe(false);
	});
});
