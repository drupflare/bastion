import {
	buildSecrets,
	CommandBook,
	commandKey,
	defaultContext,
	EXIT,
	LEAVES_THE_BOX,
	loadConfig,
	memoryFiles,
	memoryIo,
	NODE_KEY_SECRET,
	PairStore,
	scriptedRunner,
	type CommandRecord,
	type Context
} from '@drupflare/bastion';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fleetExecutors } from '../src/pair';
import { run } from '../src/run';

const CONFIG = `
version: 1
mode: solo
state: /var/lib/bastion
drivers:
  secrets:
    driver: file
    path: /var/lib/bastion/secrets.age
tenants:
  - name: acme
    sites:
      - host: www.example.edu
        bundle: ./payload.tar.gz
`;

const NODE_ID = 'nod_testnode0001';
const PLANE_KEY = 'A'.repeat(43);
const TOKEN = 'claim-token-value-0123456789';

interface Rig {
	ctx: Context;
	io: ReturnType<typeof memoryIo>;
	files: ReturnType<typeof memoryFiles>;
	requests: { url: string; body: string }[];
}

function rig(reply: { status: number; body: unknown } | null = null): Rig {
	const files = memoryFiles({ '/srv/bastion.yml': CONFIG });
	const io = memoryIo();
	const requests: Rig['requests'] = [];
	return {
		io,
		files,
		requests,
		ctx: {
			io,
			files,
			runner: scriptedRunner(),
			fetch: async (input, init) => {
				requests.push({ url: String(input), body: String(init?.body ?? '') });
				if (reply === null) throw new Error('no network in the gate lane');
				return new Response(JSON.stringify(reply.body), { status: reply.status });
			},
			env: { BASTION_TEST: '1', BASTION_SECRET_PASSPHRASE: 'a passphrase for the spec' },
			cwd: '/srv',
			platform: 'linux',
			now: () => 1_790_000_000_000
		}
	};
}

const claimed = {
	status: 201,
	body: {
		nodeId: NODE_ID,
		linkUrl: 'ws://127.0.0.1:8788/api/v1/nodes/link',
		dashboardPublicKey: PLANE_KEY
	}
};

const address = `http://127.0.0.1:8788/#${TOKEN}`;

function queued(id: string, action = 'site.rollback'): CommandRecord {
	return {
		id,
		key: commandKey('op_0123456789', 'step', id),
		envelope: {
			body: {
				nodeId: NODE_ID,
				opId: 'op_0123456789',
				stepId: 'step',
				idempotencyKey: id,
				expiresAt: 1_790_000_000_000 + 600_000,
				class: 'stateful',
				approval: 'local',
				action,
				params: { host: 'www.example.edu' }
			}
		} as unknown as CommandRecord['envelope'],
		receivedAt: 1_790_000_000_000,
		effectiveClass: 'stateful',
		state: 'queued',
		result: null,
		reported: false
	};
}

describe('bastion pair', () => {
	it('needs an address and says where to find the field list', async () => {
		const { ctx, io } = rig();
		expect(await run(ctx, ['pair', '--json'])).toBe(EXIT.USAGE);
		expect(io.outText()).toContain('bastion pair --show-fields');
	});

	it('prints every field that leaves the box without touching the network', async () => {
		const { ctx, io, requests } = rig();
		expect(await run(ctx, ['pair', '--show-fields', '--json'])).toBe(EXIT.OK);
		const printed = JSON.parse(io.outText()) as {
			leaves: { type: string; fields: { field: string }[] }[];
			never: string[];
		};
		const count = printed.leaves.reduce((n, group) => n + group.fields.length, 0);
		expect(count).toBe(LEAVES_THE_BOX.length);
		expect(printed.never.length).toBeGreaterThan(0);
		expect(requests).toEqual([]);
	});

	it('pairs against a loopback control plane and keeps the key out of the config', async () => {
		const { ctx, io, files, requests } = rig(claimed);
		expect(await run(ctx, ['pair', address, '--json'])).toBe(EXIT.OK);
		expect(JSON.parse(io.outText())).toEqual({
			paired: true,
			nodeId: NODE_ID,
			linkUrl: 'ws://127.0.0.1:8788/api/v1/nodes/link'
		});
		expect(requests).toHaveLength(1);
		// the token is in the body, never in the url that was dialled
		expect(requests[0]?.url).not.toContain(TOKEN);
		expect(JSON.parse(requests[0]?.body ?? '{}').claimToken).toBe(TOKEN);
		const record = new PairStore(ctx, '/var/lib/bastion').record();
		expect(record?.nodeId).toBe(NODE_ID);
		expect(record?.dashboardPublicKey).toBe(PLANE_KEY);
		expect(files.readText('/srv/bastion.yml')).not.toContain(NODE_ID);
		const secrets = buildSecrets(ctx, { driver: 'file', path: '/var/lib/bastion/secrets.age' });
		expect(await secrets.get(NODE_KEY_SECRET)).not.toBeNull();
	});

	it('refuses a second claim and names the way out', async () => {
		const { ctx, io } = rig(claimed);
		expect(await run(ctx, ['pair', address, '--json'])).toBe(EXIT.OK);
		io.stdout.length = 0;
		expect(await run(ctx, ['pair', address, '--json'])).toBe(EXIT.USAGE);
		expect(io.outText()).toContain('bastion unpair');
	});

	it('leaves nothing behind when the control plane refuses the token', async () => {
		const { ctx } = rig({ status: 409, body: { code: 'already_claimed' } });
		expect(await run(ctx, ['pair', address, '--json'])).toBe(EXIT.USAGE);
		expect(new PairStore(ctx, '/var/lib/bastion').record()).toBeNull();
		const secrets = buildSecrets(ctx, { driver: 'file', path: '/var/lib/bastion/secrets.age' });
		expect(await secrets.get(NODE_KEY_SECRET)).toBeNull();
	});

	it('does not print the claim token on any path', async () => {
		const { ctx, io } = rig({ status: 404, body: { code: 'invalid_token' } });
		await run(ctx, ['pair', address]);
		expect(io.outText() + io.errText()).not.toContain(TOKEN);
	});
});

describe('bastion pair status', () => {
	it('says an unpaired box sends nothing', async () => {
		const { ctx, io } = rig();
		expect(await run(ctx, ['pair', 'status'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('sends nothing');
	});

	it('lists the queued commands of a paired box without any parameter value', async () => {
		const { ctx, io } = rig(claimed);
		await run(ctx, ['pair', address, '--json']);
		new PairStore(ctx, '/var/lib/bastion').putCommand(queued('a1b2c3d4e5'));
		io.stdout.length = 0;
		expect(await run(ctx, ['pair', 'status', '--json'])).toBe(EXIT.OK);
		const status = JSON.parse(io.outText()) as {
			paired: boolean;
			nodeId: string;
			commands: { id: string; action: string; state: string }[];
		};
		expect(status.paired).toBe(true);
		expect(status.nodeId).toBe(NODE_ID);
		expect(status.commands.map((c) => [c.id, c.action, c.state])).toEqual([
			['a1b2c3d4e5', 'site.rollback', 'queued']
		]);
		expect(io.outText()).not.toContain('www.example.edu');
	});
});

describe('bastion pair status site ids', () => {
	const ids = { 'www.example.edu': 'site_testsite0001', 'docs.example.edu': 'site_testsite0002' };

	it('says no ids have arrived yet, in text and as an empty list', async () => {
		const { ctx, io } = rig(claimed);
		await run(ctx, ['pair', address, '--json']);
		io.stdout.length = 0;
		await run(ctx, ['pair', 'status']);
		expect(io.outText()).toContain('no site ids yet');
		io.stdout.length = 0;
		await run(ctx, ['pair', 'status', '--json']);
		expect((JSON.parse(io.outText()) as { sites: unknown[] }).sites).toEqual([]);
	});

	it('shows each site id with its host, and nothing else about the sites', async () => {
		const { ctx, io } = rig(claimed);
		await run(ctx, ['pair', address, '--json']);
		new PairStore(ctx, '/var/lib/bastion').replaceSiteIds(NODE_ID, ids);
		io.stdout.length = 0;
		await run(ctx, ['pair', 'status', '--json']);
		expect((JSON.parse(io.outText()) as { sites: unknown[] }).sites).toEqual([
			{ siteId: 'site_testsite0002', host: 'docs.example.edu' },
			{ siteId: 'site_testsite0001', host: 'www.example.edu' }
		]);
		io.stdout.length = 0;
		await run(ctx, ['pair', 'status']);
		const text = io.outText();
		expect(text).toContain('site id');
		expect(text).toContain('site_testsite0001');
		expect(text).toContain('docs.example.edu');
		expect(text).not.toContain('no site ids yet');
	});
});

describe('bastion pair approve and reject', () => {
	it('records the decision for serve to apply and runs nothing itself', async () => {
		const { ctx, io } = rig(claimed);
		await run(ctx, ['pair', address, '--json']);
		const store = new PairStore(ctx, '/var/lib/bastion');
		store.putCommand(queued('a1b2c3d4e5'));
		io.stdout.length = 0;
		expect(await run(ctx, ['pair', 'approve', 'a1b2c3d4e5', '--json'])).toBe(EXIT.OK);
		expect(store.decisions()).toEqual([{ id: 'a1b2c3d4e5', decision: 'approve' }]);
		expect(store.command('a1b2c3d4e5')?.state).toBe('queued');
	});

	it('records a rejection the same way', async () => {
		const { ctx } = rig(claimed);
		await run(ctx, ['pair', address, '--json']);
		const store = new PairStore(ctx, '/var/lib/bastion');
		store.putCommand(queued('f1f2f3f4f5'));
		expect(await run(ctx, ['pair', 'reject', 'f1f2f3f4f5', '--json'])).toBe(EXIT.OK);
		expect(store.decisions()).toEqual([{ id: 'f1f2f3f4f5', decision: 'reject' }]);
	});

	it('refuses an id that is not waiting', async () => {
		const { ctx } = rig(claimed);
		await run(ctx, ['pair', address, '--json']);
		expect(await run(ctx, ['pair', 'approve', 'nosuchid00', '--json'])).toBe(EXIT.USAGE);
	});

	it('refuses on a box that never paired', async () => {
		const { ctx, io } = rig();
		expect(await run(ctx, ['pair', 'approve', 'a1b2c3d4e5', '--json'])).toBe(EXIT.USAGE);
		expect(io.outText()).toContain('not-paired');
	});
});

describe('bastion unpair', () => {
	it('removes the record, the key and the queue and leaves the configuration alone', async () => {
		const { ctx, io, files } = rig(claimed);
		await run(ctx, ['pair', address, '--json']);
		const store = new PairStore(ctx, '/var/lib/bastion');
		store.putCommand(queued('a1b2c3d4e5'));
		const before = files.readText('/srv/bastion.yml');
		io.stdout.length = 0;
		expect(await run(ctx, ['unpair', '--json'])).toBe(EXIT.OK);
		expect(store.record()).toBeNull();
		expect(store.commands()).toEqual([]);
		const secrets = buildSecrets(ctx, { driver: 'file', path: '/var/lib/bastion/secrets.age' });
		expect(await secrets.get(NODE_KEY_SECRET)).toBeNull();
		expect(files.readText('/srv/bastion.yml')).toBe(before);
		expect(files.readText('/var/lib/bastion/audit.ndjson')).toContain('pair.removed');
	});

	it('refuses on a box that never paired', async () => {
		const { ctx } = rig();
		expect(await run(ctx, ['unpair', '--json'])).toBe(EXIT.USAGE);
	});
});

describe('the actions a control plane may ask for', () => {
	const executors = fleetExecutors(rig().ctx, {});

	it('holds exactly six actions and none in the destructive class', () => {
		expect(Object.keys(executors).sort()).toEqual([
			'backup.now',
			'health.observe',
			'site.add',
			'site.deploy',
			'site.rollback',
			'tenant.reload'
		]);
		for (const executor of Object.values(executors)) {
			expect(executor.class).not.toBe('destructive');
		}
	});

	it('puts the actions that change a site or the data in the stateful class', () => {
		expect(executors['site.rollback']?.class).toBe('stateful');
		expect(executors['site.add']?.class).toBe('stateful');
		expect(executors['backup.now']?.class).toBe('stateful');
		expect(executors['site.deploy']?.class).toBe('rebuild');
		expect(executors['health.observe']?.class).toBe('safe');
	});

	it('refuses a parameter the action does not take', () => {
		expect(() => executors['health.observe']?.params({ host: 'www.example.edu' })).toThrow(
			/unexpected parameter/
		);
		expect(() =>
			executors['site.rollback']?.params({ host: 'www.example.edu', force: 'yes' })
		).toThrow(/unexpected parameter/);
	});

	it('refuses a host or a version that could be read as a flag or a path', () => {
		for (const host of ['--yes', 'a b', 'x;rm -rf /', '../etc', '']) {
			expect(() => executors['site.rollback']?.params({ host })).toThrow();
		}
		expect(() =>
			executors['site.rollback']?.params({ host: 'www.example.edu', version: '--to' })
		).toThrow();
		expect(() =>
			executors['site.rollback']?.params({ host: 'www.example.edu', version: 3 })
		).toThrow();
	});

	it('refuses a bundle that is neither an https url nor an absolute path', () => {
		const params = executors['site.deploy']!.params;
		for (const bundle of ['http://x.example/p.tgz', '--checksum', './p.tgz', 'ftp://x/p']) {
			expect(() => params({ host: 'www.example.edu', bundle })).toThrow();
		}
		expect(params({ host: 'www.example.edu', bundle: '/srv/p.tgz' })).toEqual({
			host: 'www.example.edu',
			bundle: '/srv/p.tgz'
		});
		expect(() =>
			params({ host: 'www.example.edu', bundle: '/srv/p.tgz', checksum: 'md5:abc' })
		).toThrow();
	});

	it('returns the validated parameters and nothing else', () => {
		expect(
			executors['site.rollback']?.params({ host: 'www.example.edu', version: 'v12' })
		).toEqual({ host: 'www.example.edu', version: 'v12' });
		expect(executors['backup.now']?.params({})).toEqual({});
	});
});

describe('site.add', () => {
	const HOST = 'new.example.edu';
	const PATH = '/srv/payload-1.tar.gz';
	const DIGEST = `sha256:${'a'.repeat(64)}`;
	const GOOD = { 'site.js': 'import a from"./a.wasm";export default{a}', 'a.wasm': 'wasm' };

	// a box whose tar writes `tree` where it is told to, or fails; PATH holds the archive
	function boxRig(tree: Record<string, string> | 'fail' = GOOD): Rig {
		const base = rig();
		base.files.writeText(PATH, 'archive');
		const runner = scriptedRunner({
			tar: (args) => {
				if (tree === 'fail') {
					return { code: 2, stdout: '', stderr: 'gzip: stdin: not in gzip format' };
				}
				const dest = args[args.indexOf('-C') + 1]!;
				for (const [name, body] of Object.entries(tree)) {
					base.files.writeText(`${dest}/${name}`, body);
				}
				return { code: 0, stdout: '', stderr: '' };
			}
		});
		return { ...base, ctx: { ...base.ctx, runner } };
	}

	function sites(files: ReturnType<typeof memoryFiles>): string[] {
		return [...files.readText('/srv/bastion.yml').matchAll(/host: (\S+)/g)].map((m) => m[1]!);
	}

	it('refuses every bad parameter without echoing the value', () => {
		const { params } = fleetExecutors(boxRig().ctx, {})['site.add']!;
		const good = { host: HOST, bundle: PATH };
		const bad: Record<string, unknown>[] = [
			{ ...good, host: '--yes' },
			{ ...good, host: 'a b' },
			{ ...good, host: 7 },
			{ host: HOST },
			{ ...good, bundle: 'http://x.example/p.tgz' },
			{ ...good, bundle: '--checksum' },
			{ ...good, bundle: './p.tgz' },
			{ ...good, checksum: 'md5:abc' },
			{ ...good, tenant: '--tenant' },
			{ ...good, tenant: 'Acme' },
			{ ...good, tenant: 3 },
			{ ...good, force: true }
		];
		for (const raw of bad) {
			let message = '';
			try {
				params(raw);
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message, JSON.stringify(raw)).not.toBe('');
			for (const value of Object.values(raw)) {
				if (typeof value === 'string') expect(message).not.toContain(value);
			}
		}
		expect(params({ ...good, checksum: DIGEST, tenant: 'acme' })).toEqual({
			...good,
			checksum: DIGEST,
			tenant: 'acme'
		});
	});

	it('accepts the parameters of the signed site.add vector and nothing it carries is extra', () => {
		const vectors = JSON.parse(
			readFileSync(
				new URL('../../core/tests/fixtures/pair/fleet-link.json', import.meta.url),
				'utf8'
			)
		) as { positive: { name: string; input: { body: { action: string; params: object } } }[] };
		const vector = vectors.positive.find((entry) => entry.name === 'server-command-site-add')!;
		expect(vector.input.body.action).toBe('site.add');
		const params = fleetExecutors(boxRig().ctx, {})['site.add']!.params(
			vector.input.body.params as Record<string, unknown>
		);
		expect(Object.keys(params).sort()).toEqual(Object.keys(vector.input.body.params).sort());
	});

	it('adds the site to the named tenant', async () => {
		const { ctx, files } = boxRig();
		const outcome = await fleetExecutors(ctx, {})['site.add']!.run({
			host: HOST,
			bundle: PATH,
			tenant: 'acme'
		});
		expect(outcome).toEqual({ ok: true, code: null });
		expect(sites(files)).toEqual(['www.example.edu', HOST]);
		expect(files.readText('/srv/bastion.yml')).toContain(PATH);
	});

	it('unpacks the bundle before writing and leaves no unpacked files behind', async () => {
		const { ctx, files } = boxRig();
		const outcome = await fleetExecutors(ctx, {})['site.add']!.run({
			host: HOST,
			bundle: PATH
		});
		expect(outcome).toEqual({ ok: true, code: null });
		const runner = ctx.runner as ReturnType<typeof scriptedRunner>;
		expect(runner.calls.find((call) => call.command === 'tar')?.args.slice(0, 2)).toEqual([
			'-xzf',
			PATH
		]);
		expect(files.exists(`/var/lib/bastion/bundles/${HOST}/.check/site.js`)).toBe(false);
		expect(files.exists(`/var/lib/bastion/bundles/${HOST}/.check/a.wasm`)).toBe(false);
	});

	describe('with a vars file in the bundle', () => {
		const VARS =
			'{"CMS":"drupal","LAZY_FS_BUDGET_BYTES":4194304,"ASSET_AGGREGATES":1,"ON":true}';
		const ZONE = '    bindings:\n';

		const bindingsOf = (files: ReturnType<typeof memoryFiles>) => {
			const text = files.readText('/srv/bastion.yml');
			const at = text.indexOf(ZONE);
			return at === -1
				? null
				: text
						.slice(at)
						.split('\n')
						.slice(1, 5)
						.map((l) => l.trim());
		};

		it('writes the values as the site bindings, numbers and booleans as text', async () => {
			const { ctx, files } = boxRig({ ...GOOD, 'box.vars': VARS });
			const outcome = await fleetExecutors(ctx, {})['site.add']!.run({
				host: HOST,
				bundle: PATH
			});
			expect(outcome).toEqual({ ok: true, code: null });
			expect(bindingsOf(files)).toEqual([
				'CMS: drupal',
				'LAZY_FS_BUDGET_BYTES: "4194304"',
				'ASSET_AGGREGATES: "1"',
				'ON: "true"'
			]);
			expect(files.exists(`/var/lib/bastion/bundles/${HOST}/.check/box.vars`)).toBe(false);
		});

		it('answers success again on a resend, and leaves the bindings as they were', async () => {
			const { ctx, files } = boxRig({ ...GOOD, 'box.vars': VARS });
			const add = fleetExecutors(ctx, {})['site.add']!;
			await add.run({ host: HOST, bundle: PATH });
			const once = files.readText('/srv/bastion.yml');
			expect(await add.run({ host: HOST, bundle: PATH })).toEqual({ ok: true, code: null });
			expect(files.readText('/srv/bastion.yml')).toBe(once);
			expect(once.match(/CMS: drupal/g)).toHaveLength(1);
		});

		it('adds a bundle with no vars file and writes no bindings', async () => {
			const { ctx, files } = boxRig();
			const outcome = await fleetExecutors(ctx, {})['site.add']!.run({
				host: HOST,
				bundle: PATH
			});
			expect(outcome).toEqual({ ok: true, code: null });
			expect(files.readText('/srv/bastion.yml')).not.toContain('bindings');
		});

		it('writes no bindings for an empty vars object', async () => {
			const { ctx, files } = boxRig({ ...GOOD, 'box.vars': '{}' });
			await fleetExecutors(ctx, {})['site.add']!.run({ host: HOST, bundle: PATH });
			expect(sites(files)).toEqual(['www.example.edu', HOST]);
			expect(files.readText('/srv/bastion.yml')).not.toContain('bindings');
		});

		it.each([
			['is not json', 'CMS=drupal'],
			['is not an object', '["CMS"]'],
			['holds a nested value', '{"A":{"b":1}}'],
			['names a reserved binding', '{"SITE":"x"}'],
			['holds a name a binding cannot have', '{"A B":"x"}'],
			['is over the size cap', `{"A":"${'x'.repeat(20000)}"}`]
		])(
			'answers bundle_invalid for a vars file that %s, and writes nothing',
			async (_, body) => {
				const { ctx, files } = boxRig({ ...GOOD, 'box.vars': body });
				const before = files.readText('/srv/bastion.yml');
				expect(
					await fleetExecutors(ctx, {})['site.add']!.run({ host: HOST, bundle: PATH })
				).toEqual({ ok: false, code: 'bundle_invalid' });
				expect(files.readText('/srv/bastion.yml')).toBe(before);
				expect(files.exists(`/var/lib/bastion/bundles/${HOST}/.check`)).toBe(false);
			}
		);

		it('leaves the placed assets alone when the vars file is refused', async () => {
			const { ctx, files } = boxRig({ ...GOOD, 'box.vars': '[1]' });
			await fleetExecutors(ctx, {})['site.add']!.run({ host: HOST, bundle: PATH });
			expect(files.exists('/var/lib/bastion/tenants/acme/assets')).toBe(false);
		});
	});

	it.each([
		['holds no main module', { 'a.wasm': 'wasm' }],
		['names a module it does not hold', { 'site.js': 'import a from"./gone.wasm"' }],
		['reaches into a folder', { 'site.js': 'import a from"./sub/a.wasm"', 'a.wasm': 'w' }]
	])('answers bundle_invalid for a bundle that %s, and writes no config', async (_, tree) => {
		const { ctx, files } = boxRig(tree);
		const before = files.readText('/srv/bastion.yml');
		expect(
			await fleetExecutors(ctx, {})['site.add']!.run({ host: HOST, bundle: PATH })
		).toEqual({ ok: false, code: 'bundle_invalid' });
		expect(files.readText('/srv/bastion.yml')).toBe(before);
	});

	it('answers bundle_invalid when the archive does not unpack, and when there is none', async () => {
		const failed = boxRig('fail');
		const before = failed.files.readText('/srv/bastion.yml');
		expect(
			await fleetExecutors(failed.ctx, {})['site.add']!.run({ host: HOST, bundle: PATH })
		).toEqual({ ok: false, code: 'bundle_invalid' });
		expect(failed.files.readText('/srv/bastion.yml')).toBe(before);

		const { ctx } = boxRig();
		expect(
			await fleetExecutors(ctx, {})['site.add']!.run({
				host: HOST,
				bundle: '/srv/absent.tar.gz'
			})
		).toEqual({ ok: false, code: 'bundle_invalid' });
	});

	it('uses the first tenant when none is named', async () => {
		const { ctx, files } = boxRig();
		await fleetExecutors(ctx, {})['site.add']!.run({ host: HOST, bundle: PATH });
		expect(sites(files)).toContain(HOST);
	});

	it('answers a repeat for the same path with success and writes nothing twice', async () => {
		const { ctx, files } = boxRig();
		const add = fleetExecutors(ctx, {})['site.add']!;
		await add.run({ host: HOST, bundle: PATH });
		const once = files.readText('/srv/bastion.yml');
		expect(await add.run({ host: HOST, bundle: PATH })).toEqual({ ok: true, code: null });
		expect(files.readText('/srv/bastion.yml')).toBe(once);
	});

	it('answers a repeat for a file with the same digest with success', async () => {
		const { ctx, files } = boxRig();
		const bytes = new TextEncoder().encode('payload');
		files.writeBytes('/srv/held.tar.gz', bytes);
		files.writeText(
			'/srv/bastion.yml',
			CONFIG.replace('www.example.edu', HOST).replace('./payload.tar.gz', '/srv/held.tar.gz')
		);
		const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
		const add = fleetExecutors(ctx, {})['site.add']!;
		expect(await add.run({ host: HOST, bundle: PATH, checksum: digest })).toEqual({
			ok: true,
			code: null
		});
		expect(await add.run({ host: HOST, bundle: PATH, checksum: DIGEST })).toEqual({
			ok: false,
			code: 'site_exists'
		});
		expect(await add.run({ host: HOST, bundle: PATH })).toEqual({
			ok: false,
			code: 'site_exists'
		});
	});

	it('refuses a host held with a different bundle and leaves the config alone', async () => {
		const { ctx, files } = boxRig();
		const before = files.readText('/srv/bastion.yml');
		const outcome = await fleetExecutors(ctx, {})['site.add']!.run({
			host: 'www.example.edu',
			bundle: PATH
		});
		expect(outcome).toEqual({ ok: false, code: 'site_exists' });
		expect(files.readText('/srv/bastion.yml')).toBe(before);
	});

	it('refuses a box with no tenant, and a tenant it does not hold', async () => {
		const empty = boxRig();
		empty.files.writeText(
			'/srv/bastion.yml',
			'version: 1\nmode: solo\nstate: /var/lib/bastion\ntenants: []\n'
		);
		const add = fleetExecutors(empty.ctx, {})['site.add']!;
		expect(await add.run({ host: HOST, bundle: PATH })).toEqual({
			ok: false,
			code: 'no_tenant'
		});
		const { ctx } = boxRig();
		expect(
			await fleetExecutors(ctx, {})['site.add']!.run({
				host: HOST,
				bundle: PATH,
				tenant: 'nope'
			})
		).toEqual({ ok: false, code: 'unknown_tenant' });
	});

	it('passes a refusal from the command itself back as its code', async () => {
		const { ctx, files } = boxRig();
		files.writeText(
			'/srv/bastion.yml',
			CONFIG.replace('    sites:', '    limits:\n      maxSites: 1\n    sites:')
		);
		const outcome = await fleetExecutors(ctx, {})['site.add']!.run({
			host: HOST,
			bundle: PATH
		});
		expect(outcome).toEqual({ ok: false, code: 'capacity-exceeded' });
	});

	it('is held for local approval and runs once however often the command arrives', async () => {
		const { ctx, files } = boxRig();
		const config = loadConfig(ctx, {}).config;
		const book = new CommandBook({
			ctx,
			config,
			state: '/var/lib/bastion',
			executors: fleetExecutors(ctx, {})
		});
		const envelope = (id: string) =>
			({
				v: 1,
				id,
				type: 'command',
				ts: 1_790_000_000_000,
				seq: 1,
				ack: 0,
				sig: 'x'.repeat(86),
				body: {
					nodeId: NODE_ID,
					opId: 'op_testop000001',
					stepId: 'add',
					idempotencyKey: 'idem-add',
					expiresAt: 1_790_000_900_000,
					class: 'stateful',
					approval: 'automatic',
					action: 'site.add',
					params: { host: HOST, bundle: PATH }
				}
			}) as never;
		const first = await book.receive(envelope('msg_command_0001'));
		expect(first.result?.outcome).toBe('queued');
		expect(sites(files)).toEqual(['www.example.edu']);

		const again = await book.receive(envelope('msg_command_0002'));
		expect(again.id).toBe(first.id);
		expect(again.result?.outcome).toBe('queued');

		const done = await book.apply(first.id, 'approve');
		expect(done?.result?.outcome).toBe('succeeded');
		const repeated = await book.receive(envelope('msg_command_0003'));
		expect(repeated.result?.outcome).toBe('succeeded');
		expect(sites(files)).toEqual(['www.example.edu', HOST]);
	});
});

describe('site.add with a static asset tree', () => {
	const HOST = 'new.example.edu';
	const PATH = '/srv/payload-1.tar.gz';
	const ASSETS: Record<string, string> = {
		'driver.json': '{"driver":1}',
		'core/css/a.css': 'body{}',
		'drupal-pf/core.pf.bin': 'pack bytes'
	};
	const FRESH = '/var/lib/bastion/tenants/fresh/assets';
	const TWO_TENANTS = `${CONFIG}  - name: fresh\n    sites: []\n`;
	const sha = (body: string) => createHash('sha256').update(body).digest('hex');

	function manifestOf(
		assets: Record<string, string>,
		extra: Record<string, unknown>[] = []
	): string {
		return JSON.stringify({
			name: 'drupflare-box-bundle',
			version: 1,
			release: '1.1.0',
			files: [
				...Object.entries(assets).map(([path, body]) => ({
					path: `assets/${path}`,
					bytes: body.length,
					sha256: sha(body)
				})),
				...extra
			]
		});
	}

	function bundle(
		assets: Record<string, string> = ASSETS,
		manifest: string | null = manifestOf(assets)
	): Record<string, string> {
		const tree: Record<string, string> = {
			'site.js': 'import a from"./a.wasm";export default{a}',
			'a.wasm': 'wasm'
		};
		for (const [path, body] of Object.entries(assets)) tree[`assets/${path}`] = body;
		if (manifest !== null) tree['assets.manifest'] = manifest;
		return tree;
	}

	function boxRig(tree: Record<string, string>, config = TWO_TENANTS) {
		const base = rig();
		base.files.writeText('/srv/bastion.yml', config);
		base.files.writeText(PATH, 'archive');
		const runner = scriptedRunner({
			tar: (args) => {
				const dest = args[args.indexOf('-C') + 1]!;
				for (const [name, body] of Object.entries(tree)) {
					base.files.writeText(`${dest}/${name}`, body);
				}
				return { code: 0, stdout: '', stderr: '' };
			}
		});
		return { ...base, ctx: { ...base.ctx, runner } };
	}

	const add = (ctx: Context, params: Record<string, string> = {}) =>
		fleetExecutors(ctx, {})['site.add']!.run({
			host: HOST,
			bundle: PATH,
			tenant: 'fresh',
			...params
		});

	const leftovers = (files: ReturnType<typeof memoryFiles>) =>
		['.incoming', '.previous'].filter((suffix) => files.exists(`${FRESH}${suffix}`));

	it('places the unpacked assets in the tenant with the bundle hashes, before it reports success', async () => {
		const { ctx, files } = boxRig(bundle());
		expect(await add(ctx)).toEqual({ ok: true, code: null });
		for (const [path, body] of Object.entries(ASSETS)) {
			expect(sha(files.readText(`${FRESH}/${path}`))).toBe(sha(body));
		}
		expect(files.readText('/srv/bastion.yml')).toContain(HOST);
		expect(leftovers(files)).toEqual([]);
	});

	it('leaves no unpacked file behind, so the next add starts clean', async () => {
		const { ctx, files } = boxRig(bundle());
		await add(ctx);
		expect(files.exists(`/var/lib/bastion/bundles/${HOST}/.check`)).toBe(false);
		expect(files.exists(`/var/lib/bastion/bundles/${HOST}/.check/assets/driver.json`)).toBe(
			false
		);
	});

	it('places nothing for a bundle that has no assets', async () => {
		const { ctx, files } = boxRig(bundle({}, null));
		expect(await add(ctx)).toEqual({ ok: true, code: null });
		expect(files.exists(FRESH)).toBe(false);
	});

	it.each([
		[
			'an asset that differs from its manifest entry',
			() => ({ ...bundle(), 'assets/core/css/a.css': 'body{color:red}' })
		],
		[
			'an asset the manifest does not list',
			() => ({ ...bundle(), 'assets/extra.txt': 'extra' })
		],
		[
			'a listed asset the archive lacks',
			() =>
				bundle(
					ASSETS,
					manifestOf(ASSETS, [{ path: 'assets/gone', bytes: 1, sha256: sha('x') }])
				)
		],
		[
			'an entry that climbs out of the assets folder',
			() =>
				bundle(
					ASSETS,
					manifestOf(ASSETS, [{ path: 'assets/../site.js', bytes: 1, sha256: sha('x') }])
				)
		],
		['a manifest that is not json', () => bundle(ASSETS, '{')]
	])('answers bundle_invalid for %s, and changes nothing', async (_, make) => {
		const { ctx, files } = boxRig(make());
		files.writeText(`${FRESH}/old.txt`, 'old');
		const config = files.readText('/srv/bastion.yml');
		expect(await add(ctx)).toEqual({ ok: false, code: 'bundle_invalid' });
		expect(files.readText(`${FRESH}/old.txt`)).toBe('old');
		expect(files.exists(`${FRESH}/driver.json`)).toBe(false);
		expect(files.readText('/srv/bastion.yml')).toBe(config);
		expect(leftovers(files)).toEqual([]);
	});

	it('leaves the tenant and the config as they were when a file cannot be copied', async () => {
		const { ctx, files } = boxRig(bundle());
		files.writeText(`${FRESH}/old.txt`, 'old');
		const config = files.readText('/srv/bastion.yml');
		const failing: Context = {
			...ctx,
			files: {
				...files,
				link: (from, to) => {
					if (from.endsWith('a.css')) throw new Error('ENOSPC');
					files.link(from, to);
				}
			}
		};
		expect(await add(failing)).toEqual({ ok: false, code: 'assets_failed' });
		expect(files.readText(`${FRESH}/old.txt`)).toBe('old');
		expect(files.exists(`${FRESH}/driver.json`)).toBe(false);
		expect(files.readText('/srv/bastion.yml')).toBe(config);
		expect(leftovers(files)).toEqual([]);
	});

	it('puts the old assets back when the command that writes the site is refused', async () => {
		const config = TWO_TENANTS.replace(
			'  - name: fresh\n    sites: []',
			'  - name: fresh\n    limits:\n      maxSites: 0\n    sites: []'
		);
		const { ctx, files } = boxRig(bundle(), config);
		files.writeText(`${FRESH}/old.txt`, 'old');
		expect(await add(ctx)).toEqual({ ok: false, code: 'capacity-exceeded' });
		expect(files.readText(`${FRESH}/old.txt`)).toBe('old');
		expect(files.exists(`${FRESH}/driver.json`)).toBe(false);
		expect(leftovers(files)).toEqual([]);
	});

	it('answers the same bundle again with success and leaves the placed assets alone', async () => {
		const { ctx, files } = boxRig(bundle());
		await add(ctx);
		files.writeText(`${FRESH}/marker.txt`, 'kept');
		expect(await add(ctx)).toEqual({ ok: true, code: null });
		expect(files.readText(`${FRESH}/marker.txt`)).toBe('kept');
		expect(sha(files.readText(`${FRESH}/driver.json`))).toBe(sha(ASSETS['driver.json']!));
	});

	it('leaves the assets of a tenant that already serves a site', async () => {
		const { ctx, files } = boxRig(bundle());
		const own = '/var/lib/bastion/tenants/acme/assets';
		files.writeText(`${own}/own.txt`, 'mine');
		expect(await add(ctx, { tenant: 'acme' })).toEqual({ ok: true, code: null });
		expect(files.readText(`${own}/own.txt`)).toBe('mine');
		expect(files.exists(`${own}/driver.json`)).toBe(false);
	});
});

/**
 * Runs `site.add` against the box bundle the worker release builds, when `BOX_BUNDLE_ARCHIVE`
 * names one (`scripts/build-box-bundle.ts` in the worker repo); without it there is nothing to
 * read and the spec skips.
 */
describe.skipIf(!process.env['BOX_BUNDLE_ARCHIVE'])('site.add with the real box bundle', () => {
	it('places the whole asset tree under the tenant with the hashes the bundle lists', async () => {
		const archive = process.env['BOX_BUNDLE_ARCHIVE']!;
		const root = mkdtempSync(join(tmpdir(), 'bx-add-'));
		try {
			const state = join(root, 'state');
			const config = join(root, 'bastion.yml');
			writeFileSync(
				config,
				`version: 1\nmode: solo\nstate: ${state}\ntenants:\n  - name: acme\n    sites: []\n`
			);
			const ctx: Context = { ...defaultContext(), io: memoryIo(), cwd: root };
			const outcome = await fleetExecutors(ctx, { config })['site.add']!.run({
				host: 'www.example.edu',
				bundle: archive,
				tenant: 'acme'
			});
			expect(outcome).toEqual({ ok: true, code: null });

			const listed = JSON.parse(
				execFileSync('tar', ['-xOzf', archive, 'assets.manifest'], {
					encoding: 'utf8',
					maxBuffer: 1 << 26
				})
			) as { files: { path: string; bytes: number; sha256: string }[] };
			const assets = join(state, 'tenants/acme/assets');
			expect(listed.files.length).toBeGreaterThan(1000);
			for (const file of listed.files) {
				const bytes = readFileSync(join(assets, file.path.slice('assets/'.length)));
				expect(bytes.length).toBe(file.bytes);
				expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
			}
			const placed = readdirSync(assets, { recursive: true, withFileTypes: true }).filter(
				(entry) => entry.isFile()
			);
			expect(placed.length).toBe(listed.files.length);
			expect(readFileSync(config, 'utf8')).toContain('www.example.edu');
			expect(existsSync(`${assets}.incoming`)).toBe(false);
			expect(existsSync(`${assets}.previous`)).toBe(false);
			expect(existsSync(join(state, 'bundles/www.example.edu/.check'))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);
});
