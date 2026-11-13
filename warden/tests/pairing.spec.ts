import {
	EXIT,
	LEAVES_THE_BOX,
	NODE_KEY_SECRET,
	PairStore,
	buildSecrets,
	commandKey,
	memoryFiles,
	memoryIo,
	scriptedRunner,
	type CommandRecord,
	type Context
} from '@drupflare/bastion';
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

	it('holds exactly five actions and none in the destructive class', () => {
		expect(Object.keys(executors).sort()).toEqual([
			'backup.now',
			'health.observe',
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
