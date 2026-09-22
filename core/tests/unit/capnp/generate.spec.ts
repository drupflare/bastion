import { describe, expect, it } from 'vitest';
import { renderConfig, type CapnpConfig } from '../../../src/capnp/generate';

const minimal: CapnpConfig = {
	services: [
		{
			kind: 'worker',
			name: 'main',
			modules: [{ name: 'site.js', kind: 'esModule', embed: 'site.js' }],
			compatibilityDate: '2026-08-01',
			compatibilityFlags: ['nodejs_compat'],
			cacheApiOutbound: 'cache',
			durableObjectNamespaces: [
				{ className: 'SitePhpDurableObject', uniqueKey: 'k', enableSql: true }
			],
			durableObjectStorage: { localDisk: 'store' },
			bindings: [{ name: 'PLAN', kind: 'text', value: 'free' }]
		},
		{ kind: 'disk', name: 'store', path: '/var/lib/bastion/s', writable: true }
	],
	sockets: [{ name: 'http', address: 'unix:/run/b.sock', service: 'main' }]
};

describe('renderConfig', () => {
	const out = renderConfig(minimal);

	it('imports the workerd schema', () => {
		expect(out.startsWith('using Workerd = import "/workerd/workerd.capnp";')).toBe(true);
	});

	it('declares the config and one worker const', () => {
		expect(out).toContain('const config :Workerd.Config = (');
		expect(out).toContain('const wMain :Workerd.Worker = (');
		expect(out).toContain('(name = "main", worker = .wMain)');
	});

	// without it every `/` answers 500 `No Cache was configured`; it is not optional
	it('always emits cacheApiOutbound', () => {
		expect(out).toContain('cacheApiOutbound = "cache"');
	});

	it('emits enableSql, without which ctx.storage.sql is simply absent', () => {
		expect(out).toContain('enableSql = true');
	});

	it('puts durable object storage on local disk', () => {
		expect(out).toContain('durableObjectStorage = (localDisk = "store")');
	});

	it('renders a disk service with an explicit writable flag', () => {
		expect(out).toContain(
			'(name = "store", disk = (path = "/var/lib/bastion/s", writable = true))'
		);
	});

	it('renders a socket', () => {
		expect(out).toContain(
			'(name = "http", address = "unix:/run/b.sock", http = (), service = "main")'
		);
	});

	it('ends with a trailing newline', () => {
		expect(out.endsWith('\n')).toBe(true);
	});
});

describe('renderConfig escaping', () => {
	it('escapes a hostile path rather than interpolating it', () => {
		const out = renderConfig({
			services: [{ kind: 'disk', name: 'd', path: '/tmp/a", writable = true, x = "' }],
			sockets: []
		});
		// the whole entry, so the injected text is provably INSIDE one literal rather than
		// having become a second capnp key. Counting `writable = ` would pass either way,
		// because the escaped string still contains those characters.
		const entry = out
			.split('\n')
			.map((l) => l.trim())
			.find((l) => l.startsWith('(name = "d"'));
		expect(entry).toBe(
			'(name = "d", disk = (path = "/tmp/a\\", writable = true, x = \\"", writable = false))'
		);
	});
});
