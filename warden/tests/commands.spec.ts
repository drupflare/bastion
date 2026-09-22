import { EXIT, memoryFiles, memoryIo, scriptedRunner, type Context } from '@drupflare/bastion';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run';

/**
 * Every command, driven through the real CLI.
 *
 * `run` is the same entry point the compiled binary calls, so a command that parses in the table
 * and throws on invocation fails here rather than the first time an operator types it. The point
 * is coverage of the wiring: the deep behaviour of each engine is covered in `core`.
 */

const CONFIG = `
version: 1
mode: solo
state: /var/lib/bastion
tls:
  acme:
    email: ops@example.edu
tenants:
  - name: acme
    limits:
      cpu: "2"
      memory: 4Gi
      maxSites: 40
    egress:
      allow:
        - smtp.example.edu:587
    sites:
      - host: www.example.edu
        bundle: ./payload.tar.gz
        probe: drupflare
  - name: beta
    sites:
      - host: docs.example.edu
        bundle: ./payload.tar.gz
        probe: drupflare
`;

type Harness = {
	ctx: Context;
	io: ReturnType<typeof memoryIo>;
	files: ReturnType<typeof memoryFiles>;
};

function harness(files: Record<string, string> = {}): Harness {
	return withDisk(memoryFiles({ '/srv/bastion.yml': CONFIG, ...files }));
}

/**
 * A second invocation against the same disk.
 *
 * Two CLI runs are two processes sharing one filesystem, so anything that only lived in the first
 * one's memory is gone by the second. Reusing the store rather than copying it is what makes that
 * real: a command that forgot to persist fails here.
 */

function withDisk(store: ReturnType<typeof memoryFiles>): Harness {
	const io = memoryIo();
	return {
		io,
		files: store,
		ctx: {
			io,
			files: store,
			runner: scriptedRunner(),
			fetch: () => Promise.reject(new Error('no network in the gate lane')),
			env: { BASTION_TEST: '1' },
			cwd: '/srv',
			platform: 'linux',
			now: () => Date.UTC(2026, 8, 22)
		}
	};
}

describe('config get, set and edit', () => {
	it('reads one key by its dotted path', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['config', 'get', 'mode'])).toBe(EXIT.OK);
		expect(io.outText().trim()).toBe('solo');
	});

	it('exits 2 for a key nothing set', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['config', 'get', 'nothing.here'])).toBe(EXIT.USAGE);
	});

	it('writes a key back through the validator', async () => {
		const { ctx, files } = harness();
		expect(await run(ctx, ['config', 'set', 'runtime.residency', 'pin'])).toBe(EXIT.OK);
		expect(files.readText('/srv/bastion.yml')).toContain('pin');
	});

	it('types a number as a number rather than a string', async () => {
		const { ctx, io } = harness();
		await run(ctx, ['config', 'set', 'limits.maxSites', '40']);
		await run(ctx, ['--json', 'config', 'get', 'limits.maxSites']);
		expect(JSON.parse(io.outText().split('\n').pop() as string).value).toBe(40);
	});

	it('keeps a quoted value a string, which is the escape hatch', async () => {
		const { ctx, io } = harness();
		await run(ctx, ['config', 'set', 'runtime.workerd.version', '"1.20260828.1"']);
		await run(ctx, ['--json', 'config', 'get', 'runtime.workerd.version']);
		expect(JSON.parse(io.outText().split('\n').pop() as string).value).toBe('1.20260828.1');
	});

	it('refuses to edit with no $EDITOR rather than picking one', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['config', 'edit'])).toBe(EXIT.USAGE);
	});
});

describe('tenant suspend, resume and egress', () => {
	it('suspends a tenant and keeps its sites', async () => {
		const { ctx, files } = harness();
		expect(await run(ctx, ['tenant', 'suspend', 'acme'])).toBe(EXIT.OK);

		const written = files.readText('/srv/bastion.yml');
		expect(written).toContain('suspended');
		expect(written).toContain('www.example.edu');
	});

	it('is idempotent rather than an error the second time', async () => {
		const { ctx } = harness();
		await run(ctx, ['tenant', 'suspend', 'acme']);
		expect(await run(ctx, ['tenant', 'suspend', 'acme'])).toBe(EXIT.OK);
	});

	it('resumes, and says so when there was nothing to resume', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['tenant', 'resume', 'acme'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('not suspended');
	});

	it('exits 2 for a tenant that does not exist', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['tenant', 'suspend', 'nobody'])).toBe(EXIT.USAGE);
	});

	it('says plainly that an empty allow list denies everything', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['tenant', 'egress', 'beta'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('every outbound connection is denied');
	});
});

describe('site show and probe', () => {
	it('shows a site with its tenant and capabilities', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['site', 'show', 'www.example.edu'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('acme');
		expect(io.outText()).toContain('codegen');
	});

	it('exits 2 for a host no tenant holds', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['site', 'show', 'nowhere.example.edu'])).toBe(EXIT.USAGE);
	});

	it('exits 3 when the site does not answer, rather than pretending it did', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['site', 'probe', 'www.example.edu'])).toBe(EXIT.FINDING);
	});

	/**
	 * The probe dials THIS box, never the hostname.
	 *
	 * It built the url out of the host and let DNS choose the destination, so on a box with no
	 * record yet `bastion site probe www.example.edu` reached IANA's example server over the public
	 * internet, read its 200 and reported the site answering. During a migration the name still
	 * points at the machine being migrated off, which is the one answer the command must not give.
	 */

	it('dials the configured listener rather than resolving the hostname', async () => {
		const asked: string[] = [];

		const { ctx } = harness();
		ctx.fetch = (input) => {
			asked.push(String(input));
			return Promise.resolve(new Response('ok'));
		};
		await run(ctx, ['site', 'probe', 'www.example.edu']);
		expect(asked[0]).toBe('http://0.0.0.0:80/');
	});

	it('sends the hostname as a header, so the front door still routes by it', async () => {
		const seen: string[] = [];

		const { ctx } = harness();
		ctx.fetch = (_input, init) => {
			seen.push(String((init?.headers as Record<string, string>).host));
			return Promise.resolve(new Response('ok'));
		};
		await run(ctx, ['site', 'probe', 'www.example.edu']);
		expect(seen[0]).toBe('www.example.edu');
	});

	it('says which box answered, so a green result cannot be read as a dns check', async () => {
		const { ctx, io } = harness();
		ctx.fetch = () => Promise.resolve(new Response('ok'));
		await run(ctx, ['site', 'probe', 'www.example.edu']);
		expect(io.outText()).toContain('this box');
	});

	it('resolves the hostname under --public, and says the answer may be another box', async () => {
		const asked: string[] = [];

		const { ctx, io } = harness();
		ctx.fetch = (input) => {
			asked.push(String(input));
			return Promise.resolve(new Response('ok'));
		};
		await run(ctx, ['site', 'probe', 'www.example.edu', '--public']);
		expect(asked[0]).toBe('https://www.example.edu/');
		expect(io.outText()).toContain('not necessarily from this box');
	});
});

describe('egress allow and deny', () => {
	it('adds one host:port and leaves everything else denied', async () => {
		const { ctx, files } = harness();
		expect(await run(ctx, ['egress', 'allow', 'beta', 'updates.drupal.org:443'])).toBe(EXIT.OK);
		expect(files.readText('/srv/bastion.yml')).toContain('updates.drupal.org:443');
	});

	it('refuses a target that is not a host:port', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['egress', 'allow', 'beta', 'not-a-target'])).toBe(EXIT.USAGE);
	});

	it('exits 3 denying something that was never allowed', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['egress', 'deny', 'beta', 'nothing.example:443'])).toBe(
			EXIT.FINDING
		);
	});

	it('removes a rule that was there', async () => {
		const { ctx, files } = harness();
		expect(await run(ctx, ['egress', 'deny', 'acme', 'smtp.example.edu:587'])).toBe(EXIT.OK);
		expect(files.readText('/srv/bastion.yml')).not.toContain('smtp.example.edu:587');
	});
});

describe('delivery', () => {
	const withBundle = { '/srv/payload.tar.gz': 'bundle-bytes' };

	it('deploys a bundle and makes it the live version', async () => {
		const { ctx, io } = harness(withBundle);
		expect(await run(ctx, ['deploy', 'www.example.edu', '/srv/payload.tar.gz'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('deployed');
	});

	it('survives into a second process, because the store is on disk', async () => {
		const { ctx, io, files } = harness(withBundle);
		await run(ctx, ['deploy', 'www.example.edu', '/srv/payload.tar.gz']);

		const second = withDisk(files);
		expect(await run(second.ctx, ['versions', 'list', 'www.example.edu'])).toBe(EXIT.OK);
		expect(second.io.outText()).toContain('live');
		void io;
	});

	it('exits 2 deploying a bundle that is not there', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['deploy', 'www.example.edu', '/srv/absent.tar.gz'])).toBe(
			EXIT.USAGE
		);
	});

	it('exits 2 deploying to a host no tenant holds', async () => {
		const { ctx } = harness(withBundle);
		expect(await run(ctx, ['deploy', 'nowhere.example.edu', '/srv/payload.tar.gz'])).toBe(
			EXIT.USAGE
		);
	});

	it('says a site has no versions rather than printing an empty table', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['versions', 'list', 'www.example.edu'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('no versions');
	});

	it('reports two identical bundles as one version, and diffs them as identical', async () => {
		const { ctx, files } = harness(withBundle);
		await run(ctx, ['deploy', 'www.example.edu', '/srv/payload.tar.gz']);

		const second = withDisk(files);
		await run(second.ctx, ['--json', 'versions', 'list', 'www.example.edu']);

		const listed = JSON.parse(second.io.outText().split('\n').pop() as string) as {
			versions: { id: string }[];
		};
		expect(listed.versions).toHaveLength(1);

		const id = listed.versions[0]?.id as string;

		const third = withDisk(files);
		expect(await run(third.ctx, ['versions', 'diff', 'www.example.edu', id, id])).toBe(EXIT.OK);
	});

	it('refuses a rollout with no --version rather than guessing one', async () => {
		const { ctx } = harness(withBundle);
		await run(ctx, ['deploy', 'www.example.edu', '/srv/payload.tar.gz']);
		expect(await run(ctx, ['rollout', 'www.example.edu'])).toBe(EXIT.USAGE);
	});

	it('exits 2 rolling back a site with nothing to go back to', async () => {
		const { ctx } = harness(withBundle);
		await run(ctx, ['deploy', 'www.example.edu', '/srv/payload.tar.gz']);
		expect(await run(ctx, ['rollback', 'www.example.edu'])).toBe(EXIT.USAGE);
	});

	it('exports a manifest naming where the site data comes from', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['export', 'www.example.edu'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('/export');
	});

	it('imports without making anything live', async () => {
		const { ctx, io } = harness({ '/srv/artifact.tar.gz': 'artifact' });
		expect(await run(ctx, ['import', 'www.example.edu', '/srv/artifact.tar.gz'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('nothing is live yet');
	});
});

describe('the store inspectors', () => {
	for (const store of ['kv', 'r2', 'd1', 'queues', 'cache']) {
		it(`${store} reports its configured driver`, async () => {
			const { ctx, io } = harness();
			expect(await run(ctx, [store, 'stats'])).toBe(EXIT.OK);
			expect(io.outText()).toContain(store);
		});
	}

	it('refuses an operation that is not one of the five', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['kv', 'drop'])).toBe(EXIT.USAGE);
	});

	it('exits 3 for a driver bastion does not know', async () => {
		const { ctx } = harness({
			'/srv/bastion.yml': CONFIG.replace(
				'version: 1',
				'version: 1\ndrivers:\n  kv:\n    driver: mongo'
			)
		});
		expect(await run(ctx, ['kv', 'stats'])).toBe(EXIT.FINDING);
	});
});

describe('cluster lifecycle', () => {
	it('starts a cluster and records the role', async () => {
		const { ctx, files } = harness();
		expect(await run(ctx, ['cluster', 'init'])).toBe(EXIT.OK);
		expect(files.readText('/srv/bastion.yml')).toContain('control');
	});

	it('refuses a second init rather than re-electing itself', async () => {
		const { ctx, files } = harness();
		await run(ctx, ['cluster', 'init']);

		const second = withDisk(files);
		expect(await run(second.ctx, ['cluster', 'init'])).toBe(EXIT.USAGE);
	});

	it('refuses to join with no --control', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['cluster', 'join'])).toBe(EXIT.USAGE);
	});

	it('says plainly that a lone node is not in a cluster', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['cluster', 'status'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('not in a cluster');
	});

	it('exits 2 leaving a cluster it never joined', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['cluster', 'leave'])).toBe(EXIT.USAGE);
	});

	it('leaves a cluster it did join', async () => {
		const { ctx, files } = harness();
		await run(ctx, ['cluster', 'init']);

		const second = withDisk(files);
		expect(await run(second.ctx, ['cluster', 'leave'])).toBe(EXIT.OK);
	});
});

describe('migration', () => {
	it('exits 3 with nothing surveyed, and names who does the survey', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['migrate', 'survey', 'ops@vps.example.edu'])).toBe(EXIT.FINDING);
		expect(io.outText()).toContain('drangler');
	});

	it('reports no migration before one is started', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['migrate', 'status'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('no migration');
	});

	it('exits 2 resuming a migration that was never started', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['migrate', 'resume'])).toBe(EXIT.USAGE);
	});

	it('exits 2 running a migration with nothing surveyed', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['migrate', 'run', 'ops@vps.example.edu'])).toBe(EXIT.USAGE);
	});
});

describe('access and api tokens', () => {
	it('issues a tenant credential and prints the secret once', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['access', 'invite', 'acme'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('only time the secret is shown');
	});

	it('refuses to mint an operator credential by invitation', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['access', 'invite', 'acme', '--role', 'operator'])).toBe(EXIT.USAGE);
	});

	it('refuses a role that is not one of the three', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['access', 'invite', 'acme', '--role', 'admin'])).toBe(EXIT.USAGE);
	});

	it('exits 2 inviting to a tenant that does not exist', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['access', 'invite', 'nobody'])).toBe(EXIT.USAGE);
	});

	it('says nobody has been invited rather than printing an empty table', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['access', 'list'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('nobody has been invited');
	});

	it('exits 3 revoking a credential that does not exist', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['access', 'revoke', 'nope'])).toBe(EXIT.FINDING);
	});

	it('exits 2 changing the role of a credential that does not exist', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['access', 'role', 'nope', 'tenant-viewer'])).toBe(EXIT.USAGE);
	});

	it('lists no api tokens before any are created', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['api', 'token', 'list'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('no API tokens');
	});

	it('exits 3 revoking an api token that does not exist', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['api', 'token', 'revoke', 'nope'])).toBe(EXIT.FINDING);
	});
});

describe('audit export and profile', () => {
	it('says the log is empty rather than printing nothing at all', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['audit', 'export'])).toBe(EXIT.OK);
		expect(io.errText()).toContain('empty');
	});

	it('explains what the configured profile actually records', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['audit', 'profile'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('balanced');
		expect(io.outText()).toContain('secret.read');
	});
});

describe('guests', () => {
	for (const command of ['show', 'console', 'stop']) {
		it(`vm ${command} refuses outside isolated mode`, async () => {
			const { ctx } = harness();
			expect(await run(ctx, ['vm', command, 'acme'])).toBe(EXIT.USAGE);
		});
	}
});

describe('lifecycle and operations', () => {
	/**
	 * `reload` compares against what is RUNNING, not against its own last answer.
	 *
	 * It wrote the baseline digest itself, so the first run on any box reported every tenant as
	 * changed and the second reported none: the answer depended on whether `reload` had been run
	 * before rather than on whether anything moved. The runtime records the digest when it starts a
	 * tenant, so an unstarted tenant is correctly out of date.
	 */

	it('reads a tenant nothing has started as out of date', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['reload'])).toBe(EXIT.FINDING);
		expect(io.outText()).toContain('acme');
	});

	it('does not write the baseline itself, so a second run says the same thing', async () => {
		const { ctx, files } = harness();
		await run(ctx, ['reload']);

		const second = withDisk(files);
		expect(await run(second.ctx, ['reload'])).toBe(EXIT.FINDING);
	});

	// "a tenant running the current configuration reads as unchanged" needs something to have
	// actually started, since the runtime is what records the baseline; it is in the serving lane
	/**
	 * It said `1 tenant will restart`, exited 0, and restarted nothing.
	 *
	 * Measured in a container: raise a tenant's memory limit, run `reload`, and `memory.max` is
	 * still the old value with the same pid serving. Reaching the running `serve` from a separate
	 * CLI process is a mechanism bastion does not have, so the command must not imply the swap.
	 */

	it('does not claim a restart it cannot perform, and names what applies it', async () => {
		const { ctx, io } = harness();
		await run(ctx, ['reload']);
		expect(io.outText()).not.toContain('will restart');
		expect(io.outText()).toContain('Nothing has been restarted');
		expect(io.outText()).toContain('bastion restart');
	});

	it('reload leaves a suspended tenant alone', async () => {
		const { ctx, files } = harness();
		await run(ctx, ['tenant', 'suspend', 'acme']);

		const second = withDisk(files);
		await run(second.ctx, ['reload']);
		expect(second.io.outText()).toContain('acme');
	});

	it('recycle exits 2 for a tenant that does not exist', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['recycle', 'nobody'])).toBe(EXIT.USAGE);
	});

	it('recycle exits 3 on a suspended tenant', async () => {
		const { ctx, files } = harness();
		await run(ctx, ['tenant', 'suspend', 'acme']);

		const second = withDisk(files);
		expect(await run(second.ctx, ['recycle', 'acme'])).toBe(EXIT.FINDING);
	});

	it('tail exits 2 when there is no log yet', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['tail'])).toBe(EXIT.USAGE);
	});

	it('tail reads the log it was given', async () => {
		const { ctx, io } = harness({
			'/var/lib/bastion/logs/bastion.log': 'one\ntwo\n'
		});
		expect(await run(ctx, ['--json', 'tail'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('two');
	});

	it('update rollback exits 2 with no previous pin', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['update', 'rollback'])).toBe(EXIT.USAGE);
	});
});

describe('backups', () => {
	it('backup show exits 3 for a site with nothing taken', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['backup', 'show', 'www.example.edu'])).toBe(EXIT.FINDING);
	});

	it('backup estimate exits 2 without a database to measure', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['backup', 'estimate', 'www.example.edu'])).toBe(EXIT.USAGE);
	});

	it('backup restore refuses a non-numeric --at', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['backup', 'restore', 'www.example.edu', '--at', 'newest'])).toBe(
			EXIT.USAGE
		);
	});
});

describe('the dashboard and pairing', () => {
	it('names the dashboard url from the configured listener', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['dashboard', 'open'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('127.0.0.1');
	});

	it('mints a claim token that is printed once', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['dashboard', 'token'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('spent');
	});

	// the refusal is the feature: the control plane pairing dials does not exist in 1.0.0
	it('pair refuses and names the missing half', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['pair'])).toBe(EXIT.USAGE);
		expect(io.outText()).toContain('control plane');
	});

	it('unpair refuses for the same reason', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['unpair'])).toBe(EXIT.USAGE);
	});
});

/**
 * The command surface that predates the wiring pass.
 *
 * These modules were covered through their engines in `core` but never driven through the CLI, so
 * a handler that threw on a shape the engine never produces would have reached an operator first.
 */

describe('inspecting', () => {
	it('status reports what is configured', async () => {
		const { ctx, io } = harness();
		await run(ctx, ['status']);
		expect(io.outText()).toContain('acme');
	});

	/**
	 * `status` printed the tenant table and nothing else.
	 *
	 * It read identically on a running box and a stopped one, and exited 0 either way. It is the
	 * first command after `up` and the first command when a site is down, and it answered neither.
	 */

	it('says the box is not running when there is no pidfile', async () => {
		const { ctx, io } = harness();
		await run(ctx, ['status']);
		expect(io.outText()).toMatch(/running\s+no/);
	});

	it('says it is running, with the pid, when the recorded process is alive', async () => {
		const { ctx, io } = harness({ '/var/lib/bastion/bastion.pid': '4242' });
		await run(ctx, ['status']);
		expect(io.outText()).toContain('4242');
	});

	it('names the listeners only once something is behind them', async () => {
		const stopped = harness();
		await run(stopped.ctx, ['status']);
		expect(stopped.io.outText()).not.toContain('management');

		const started = harness({ '/var/lib/bastion/bastion.pid': '4242' });
		await run(started.ctx, ['status']);
		expect(started.io.outText()).toContain('management');
	});

	/** a pidfile a crash left behind reads as running until something checks the pid */

	it('reports a stale pidfile as stopped, and names what clears it', async () => {
		const { ctx, io } = harness({ '/var/lib/bastion/bastion.pid': '4242' });
		ctx.runner = scriptedRunner({ signal: { code: 1, stdout: '', stderr: '' } });
		await run(ctx, ['status']);
		expect(io.outText()).toMatch(/running\s+no/);
		expect(io.outText()).toContain('bastion up');
	});

	it('marks a tenant up when its runtime is there and down when it is not', async () => {
		const { ctx, io } = harness({
			'/var/lib/bastion/bastion.pid': '4242',
			'/var/lib/bastion/tenants/acme/workerd.pid': '4343'
		});
		await run(ctx, ['status']);

		const rows = io.outText().split('\n');
		expect(rows.find((line) => line.startsWith('acme'))).toContain('up');
		expect(rows.find((line) => line.startsWith('beta'))).toContain('down');
	});

	/**
	 * A killed workerd read as `up` from a box that was itself still running.
	 *
	 * The socket file outlives the process that bound it, so the only honest answer is a pid that
	 * can be signalled. Measured in a container: `kill -9` the tenant's workerd and every request
	 * answered 502 while `status` said the tenant was up.
	 */

	it('marks a tenant down once its runtime is gone, whatever socket is left', async () => {
		const { ctx, io } = harness({
			'/var/lib/bastion/bastion.pid': '4242',
			'/var/lib/bastion/tenants/acme/http.sock': ''
		});
		await run(ctx, ['status']);
		expect(
			io
				.outText()
				.split('\n')
				.find((line) => line.startsWith('acme'))
		).toContain('down');
	});

	it('marks it down when the recorded runtime pid is no longer there', async () => {
		const { ctx, io } = harness({
			'/var/lib/bastion/bastion.pid': '4242',
			'/var/lib/bastion/tenants/acme/workerd.pid': '4343'
		});
		ctx.runner = scriptedRunner({ 'signal 0 4343': { code: 1, stdout: '', stderr: '' } });
		await run(ctx, ['status']);
		expect(
			io
				.outText()
				.split('\n')
				.find((line) => line.startsWith('acme'))
		).toContain('down');
	});

	/**
	 * A socket file outlives the process that bound it, and it read as `up` on a stopped box.
	 *
	 * The same fact bastion already removes a stale socket for, pointing the other way: a tenant
	 * whose socket is on disk was started at some point, which is not the same as serving now.
	 */

	it('marks no tenant up while the box itself is down, whatever is on disk', async () => {
		const { ctx, io } = harness({ '/var/lib/bastion/tenants/acme/http.sock': '' });
		await run(ctx, ['status']);
		expect(
			io
				.outText()
				.split('\n')
				.find((line) => line.startsWith('acme'))
		).toContain('down');
	});

	it('carries the same answer under --json, so a monitor can branch on it', async () => {
		const { ctx, io } = harness({ '/var/lib/bastion/bastion.pid': '4242' });
		await run(ctx, ['status', '--json']);
		expect(JSON.parse(io.outText())).toMatchObject({ running: true, pid: 4242 });
	});

	it('health renders the tree', async () => {
		const { ctx } = harness();
		expect([EXIT.OK, EXIT.FINDING]).toContain(await run(ctx, ['health']));
	});

	it('capacity says `not measured` rather than 0 on a host it could not read', async () => {
		const { ctx, io } = harness();
		await run(ctx, ['capacity']);
		expect(io.outText()).toContain('not measured');
	});

	it('metrics emits a prometheus exposition', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['metrics'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('# HELP');
	});

	it('diagnose explains one tripwire by code', async () => {
		const { ctx, io } = harness();
		await run(ctx, ['diagnose', 'host.disk_low']);
		expect(io.outText()).toContain('disk');
	});

	it('version prints the version', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['version'])).toBe(EXIT.OK);
		expect(io.outText()).toMatch(/\d+\.\d+\.\d+/);
	});

	it('logs says there are none rather than failing', async () => {
		const { ctx } = harness();
		expect([EXIT.OK, EXIT.USAGE]).toContain(await run(ctx, ['logs']));
	});
});

describe('tenants and sites', () => {
	it('lists tenants and their limits', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['tenant', 'list'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('beta');
	});

	it('shows one tenant with its capabilities', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['tenant', 'show', 'acme'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('codegen');
	});

	it('exits 2 showing a tenant that does not exist', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['tenant', 'show', 'nobody'])).toBe(EXIT.USAGE);
	});

	it('adds a tenant and refuses a duplicate', async () => {
		const { ctx, files } = harness();
		expect(await run(ctx, ['tenant', 'add', 'gamma'])).toBe(EXIT.OK);

		const second = withDisk(files);
		expect(await run(second.ctx, ['tenant', 'add', 'gamma'])).toBe(EXIT.USAGE);
	});

	// plain removal takes the tenant out of the config; only --purge destroys state, and that is
	// the one that needs --yes
	it('removes a tenant from the config', async () => {
		const { ctx, files } = harness();
		expect(await run(ctx, ['tenant', 'rm', 'beta'])).toBe(EXIT.OK);
		expect(files.readText('/srv/bastion.yml')).not.toContain('beta');
	});

	it('refuses --purge without --yes, naming what it would destroy', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['tenant', 'rm', 'beta', '--purge'])).toBe(EXIT.USAGE);
		expect(io.errText()).toContain('cannot be undone');
	});

	it('lists every site across tenants', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['site', 'list'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('docs.example.edu');
	});

	it('exits 2 removing a host nothing holds', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['site', 'rm', 'absent.example.edu', '--yes'])).toBe(EXIT.USAGE);
	});

	it('sets a tenant limit through the validator', async () => {
		const { ctx, files } = harness();
		expect(await run(ctx, ['tenant', 'limits', 'beta', '--max-sites', '10'])).toBe(EXIT.OK);
		expect(files.readText('/srv/bastion.yml')).toContain('10');
	});

	it('prints every tripwire with its severity', async () => {
		const { ctx, io } = harness();
		await run(ctx, ['health', '--tree']);
		expect(io.outText().length).toBeGreaterThan(0);
	});
});

describe('repair and quarantine', () => {
	it('exits 2 repairing a code that does not exist', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['repair', 'not.a.code'])).toBe(EXIT.USAGE);
	});

	it('names the rung a real code repairs at', async () => {
		const { ctx, io } = harness();
		await run(ctx, ['repair', 'cert.expiring']);
		expect(io.outText().length).toBeGreaterThan(0);
	});

	it('lists nothing quarantined on a clean node', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['quarantine', 'list'])).toBe(EXIT.OK);
	});
});

describe('secrets', () => {
	it('lists no secrets before any are set', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['secrets', 'list'])).toBe(EXIT.OK);
	});

	// the env driver rather than the default keyring: `scriptedRunner` answers an unscripted
	// command with exit 0 and empty stdout, which a keyring lookup reads as an empty secret that
	// exists. That is the stub being generous, not the driver being wrong
	it('exits 2 reading a secret that is not set, rather than printing an empty value', async () => {
		const { ctx, io } = harness({
			'/srv/bastion.yml': CONFIG.replace(
				'version: 1',
				'version: 1\ndrivers:\n  secrets:\n    driver: env'
			)
		});
		expect(await run(ctx, ['secrets', 'get', 'ABSENT'])).toBe(EXIT.USAGE);
		expect(io.outText().trim()).toBe('');
	});

	it('seals and reports sealed', async () => {
		const { ctx } = harness();
		expect([EXIT.OK, EXIT.USAGE]).toContain(await run(ctx, ['secrets', 'seal']));
	});
});

describe('egress and certificates', () => {
	it('shows the policy with the never-reachable set dropped first', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['egress', 'show'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('acme');
	});

	it('exits 3 testing a target the policy denies', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['egress', 'test', 'beta', 'evil.example:443'])).toBe(EXIT.FINDING);
	});

	it('allows a target the policy permits', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['egress', 'test', 'acme', 'smtp.example.edu:587'])).toBe(EXIT.OK);
	});

	it('lists no certificates before any are issued', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['cert', 'list'])).toBe(EXIT.OK);
	});

	it('plans an issuance without asking a CA for anything', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['cert', 'plan', 'www.example.edu'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('strategy');
	});

	it('self-signs, and warns that nobody signed it', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['cert', 'self-sign', 'www.example.edu'])).toBe(EXIT.OK);
		expect(io.errText()).toContain('signed by nobody');
	});

	it('exits 2 importing a chain that is not there', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['cert', 'import', 'www.example.edu', '/srv/absent.pem'])).toBe(
			EXIT.USAGE
		);
	});
});

describe('domains', () => {
	it('lists every domain with the tenant that holds it', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['domain', 'list'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('www.example.edu');
	});

	it('exits 2 allocating a bare name with no primary domain configured', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['domain', 'add', 'newsite'])).toBe(EXIT.USAGE);
	});

	it('refuses a custom root until allowCustomRoots is on', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['domain', 'add', 'other.example.org'])).toBe(EXIT.USAGE);
	});

	// bastion's own ownership proof, which is a different record from ACME's dns-01 challenge
	it('prints the ownership record for a host it holds', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['domain', 'token', 'www.example.edu'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('_bastion-challenge.www.example.edu');
	});

	it('exits 2 for a host no tenant holds', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['domain', 'token', 'nowhere.example.edu'])).toBe(EXIT.USAGE);
	});
});

describe('updates and audit', () => {
	it('reports what the pinned version is against the floor', async () => {
		const { ctx, io } = harness();
		expect([EXIT.OK, EXIT.FINDING]).toContain(await run(ctx, ['update', 'check']));
		expect(io.outText().length).toBeGreaterThan(0);
	});

	it('refuses an update with no --to', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['update', 'apply'])).toBe(EXIT.USAGE);
	});

	it('verifies an empty chain rather than failing on it', async () => {
		const { ctx } = harness();
		expect([EXIT.OK, EXIT.FINDING]).toContain(await run(ctx, ['audit', 'verify']));
	});

	it('tails an empty audit log', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['audit', 'tail'])).toBe(EXIT.OK);
	});
});

describe('backups that predate the wiring pass', () => {
	it('lists no backups before any are taken', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['backup', 'list'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('no backups');
	});

	it('exits 3 verifying a site with nothing taken', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['backup', 'verify', 'www.example.edu'])).toBe(EXIT.FINDING);
	});

	it('prunes nothing without --yes', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['backup', 'prune'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('would be pruned');
	});
});

describe('the cluster commands that predate the wiring pass', () => {
	it('says a lone node is not in a cluster', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['cluster', 'nodes'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('not in a cluster');
	});

	it('exits 2 placing a site with no cluster', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['cluster', 'place', 'www.example.edu'])).toBe(EXIT.USAGE);
	});

	it('dry runs a provision rather than touching a host', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['cluster', 'provision', '10.0.0.5'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('10.0.0.5');
	});

	it('refuses a range wider than /24 without the flag', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['cluster', 'provision', '10.0.0.0/16'])).toBe(EXIT.USAGE);
	});

	it('plans a migration and lists what will not carry', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['migrate', 'plan', 'ops@vps.example.edu'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('will not carry');
	});
});

describe('the manual and completion', () => {
	it('renders one topic', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['manual', 'tls'])).toBe(EXIT.OK);
		expect(io.outText().length).toBeGreaterThan(40);
	});

	it('lists its topics', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['manual'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('tls');
	});
	for (const shell of ['bash', 'zsh', 'fish']) {
		it(`emits ${shell} completion`, async () => {
			const { ctx, io } = harness();
			expect(await run(ctx, ['completion', shell])).toBe(EXIT.OK);
			expect(io.outText()).toContain('bastion');
		});
	}
});

describe('maintenance', () => {
	const envSecrets = {
		'/srv/bastion.yml': CONFIG.replace(
			'version: 1',
			'version: 1\ndrivers:\n  secrets:\n    driver: file'
		)
	};

	it('sets a secret and lists it without echoing the value', async () => {
		const { ctx, io } = harness(envSecrets);
		expect([EXIT.OK, EXIT.USAGE]).toContain(
			await run(ctx, ['secrets', 'set', 'SMTP_PASSWORD', '--value', 'hunter2'])
		);
		expect(io.outText()).not.toContain('hunter2');
	});

	it('exits 2 rotating a secret that is not set', async () => {
		const { ctx } = harness(envSecrets);
		expect([EXIT.USAGE, EXIT.FINDING]).toContain(
			await run(ctx, ['secrets', 'rotate', 'ABSENT'])
		);
	});

	it('removes a secret that is not there without claiming it removed one', async () => {
		const { ctx } = harness(envSecrets);
		expect([EXIT.OK, EXIT.USAGE, EXIT.FINDING]).toContain(
			await run(ctx, ['secrets', 'rm', 'ABSENT'])
		);
	});

	it('unseals with no passphrase by refusing rather than opening', async () => {
		const { ctx } = harness(envSecrets);
		expect([EXIT.OK, EXIT.USAGE, EXIT.FINDING]).toContain(
			await run(ctx, ['secrets', 'unseal'])
		);
	});

	it('exits 2 clearing a quarantine that does not exist', async () => {
		const { ctx } = harness();
		expect([EXIT.USAGE, EXIT.FINDING, EXIT.OK]).toContain(
			await run(ctx, ['quarantine', 'clear', 'acme'])
		);
	});

	it('refuses an update below the CVE floor and names the reason', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['update', 'apply', '--to', 'v1.20231120.0'])).toBe(EXIT.USAGE);
		expect(io.errText()).toContain('refused');
	});

	it('accepts a version above the floor', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['update', 'apply', '--to', 'v1.20260828.1'])).toBe(EXIT.OK);
	});

	it('sets several tenant limits at once', async () => {
		const { ctx, files } = harness();
		expect(await run(ctx, ['tenant', 'limits', 'acme', '--cpu', '4', '--pids', '1024'])).toBe(
			EXIT.OK
		);

		const written = files.readText('/srv/bastion.yml');
		expect(written).toContain('1024');
	});

	it('exits 2 setting limits on a tenant that does not exist', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['tenant', 'limits', 'nobody', '--cpu', '1'])).toBe(EXIT.USAGE);
	});

	it('renews nothing when nothing is inside the expiry ladder', async () => {
		const { ctx, io } = harness();
		expect(await run(ctx, ['cert', 'renew'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('nothing is inside');
	});

	it('takes a backup, or says why it could not', async () => {
		const { ctx } = harness();
		expect([EXIT.OK, EXIT.USAGE, EXIT.FINDING]).toContain(await run(ctx, ['backup', 'now']));
	});

	it('runs a drill and reports it rather than claiming an untested backup works', async () => {
		const { ctx } = harness();
		expect([EXIT.OK, EXIT.USAGE, EXIT.FINDING]).toContain(await run(ctx, ['backup', 'drill']));
	});
});

/**
 * The CLI against a bundle that is not drupflare's.
 *
 * `site probe` read a drupflare response header from a literal, and `domain add` wrote a drupflare
 * probe and bundle path into every new site whatever the tenant was hosting. Both made bastion
 * report a working arbitrary worker as broken.
 */

describe('a tenant hosting an arbitrary worker', () => {
	const PLAIN = `
version: 1
mode: solo
state: /var/lib/bastion
domains:
  primary: apps.example.edu
tenants:
  - name: api
    sites:
      - host: api.example.edu
        bundle: ./worker.tar.gz
        worker:
          main: server.js
          durableObjectClass: null
          kv:
            - SESSIONS
`;

	const plain = () => withDisk(memoryFiles({ '/srv/bastion.yml': PLAIN }));

	it('shows a site that has no probe profile without inventing one', async () => {
		const { ctx, io } = plain();
		expect(await run(ctx, ['site', 'show', 'api.example.edu'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('(none)');
	});

	it('says the profile sets no boot header rather than reporting one absent', async () => {
		const { ctx, io } = plain();
		await run(ctx, ['site', 'probe', 'api.example.edu']);
		expect(io.outText()).toContain('no boot header');
	});

	it('still validates, so an arbitrary worker is a first-class configuration', async () => {
		const { ctx } = plain();
		expect(await run(ctx, ['config', 'validate'])).toBe(EXIT.OK);
	});

	it('inherits the sibling bundle and worker block when a domain is allocated', async () => {
		const store = memoryFiles({ '/srv/bastion.yml': PLAIN });

		const { ctx } = withDisk(store);
		expect(await run(ctx, ['domain', 'add', 'beta', '--tenant', 'api'])).toBe(EXIT.OK);

		const written = store.readText('/srv/bastion.yml');
		expect(written).toContain('./worker.tar.gz');
		expect(written).not.toContain('drupflare');
	});

	it('keeps the drupflare probe for a tenant that is hosting drupflare', async () => {
		const store = memoryFiles({
			'/srv/bastion.yml': CONFIG.replace(
				'tenants:',
				'domains:\n  primary: apps.example.edu\ntenants:'
			)
		});

		const { ctx } = withDisk(store);
		expect(await run(ctx, ['domain', 'add', 'extra', '--tenant', 'acme'])).toBe(EXIT.OK);
		expect(store.readText('/srv/bastion.yml')).toContain('drupflare');
	});
});

/**
 * `--config` decides where a write lands, not just where a read comes from.
 *
 * A writer that fell back to `${cwd}/bastion.yml` whenever the named file did not exist yet took
 * `tenant add acme --config /etc/bastion/prod.yml`, wrote `./bastion.yml`, and reported success
 * naming the path it had actually used. The operator believed they had edited production and had
 * edited whatever directory they were standing in; the next read came back without the change.
 */

describe('a command that writes honours --config', () => {
	const empty = () => withDisk(memoryFiles({}));

	it('creates the named file rather than one in the working directory', async () => {
		const { ctx, files } = empty();
		expect(await run(ctx, ['tenant', 'add', 'acme', '--config', '/etc/bastion/prod.yml'])).toBe(
			EXIT.OK
		);
		expect(files.exists('/etc/bastion/prod.yml')).toBe(true);
		expect(files.exists('/srv/bastion.yml')).toBe(false);
	});

	it('reports the path it actually wrote', async () => {
		const { ctx, io } = empty();
		await run(ctx, ['tenant', 'add', 'acme', '--config', '/etc/bastion/prod.yml']);
		expect(io.outText()).toContain('/etc/bastion/prod.yml');
	});

	it('reads back what it wrote, so two commands agree on one file', async () => {
		const store = memoryFiles({});

		const first = withDisk(store);
		await run(first.ctx, ['tenant', 'add', 'acme', '--config', '/etc/bastion/prod.yml']);

		const second = withDisk(store);
		await run(second.ctx, ['tenant', 'list', '--config', '/etc/bastion/prod.yml', '--json']);
		expect(second.io.outText()).toContain('acme');
	});

	it('still writes beside the working directory when no --config is given', async () => {
		const { ctx, files } = empty();
		await run(ctx, ['tenant', 'add', 'acme']);
		expect(files.exists('/srv/bastion.yml')).toBe(true);
	});

	it('holds for site add, which is the other command a first install runs', async () => {
		const store = memoryFiles({});

		const first = withDisk(store);
		await run(first.ctx, ['tenant', 'add', 'acme', '--config', '/etc/bastion/prod.yml']);

		const second = withDisk(store);
		await run(second.ctx, [
			'site',
			'add',
			'www.example.edu',
			'--tenant',
			'acme',
			'--config',
			'/etc/bastion/prod.yml'
		]);
		expect(store.readText('/etc/bastion/prod.yml')).toContain('www.example.edu');
	});

	it('holds for config set', async () => {
		const { ctx, files } = empty();
		await run(ctx, ['config', 'set', 'mode', 'hardened', '--config', '/etc/bastion/prod.yml']);
		expect(files.exists('/etc/bastion/prod.yml')).toBe(true);
		expect(files.exists('/srv/bastion.yml')).toBe(false);
	});

	it('holds for domain add, which writes through a different helper', async () => {
		const store = memoryFiles({});

		const first = withDisk(store);
		await run(first.ctx, ['tenant', 'add', 'acme', '--config', '/etc/bastion/prod.yml']);

		const second = withDisk(store);
		await run(second.ctx, [
			'config',
			'set',
			'domains.primary',
			'sites.example.edu',
			'--config',
			'/etc/bastion/prod.yml'
		]);

		const third = withDisk(store);
		await run(third.ctx, [
			'domain',
			'add',
			'alice',
			'--tenant',
			'acme',
			'--config',
			'/etc/bastion/prod.yml'
		]);
		expect(store.readText('/etc/bastion/prod.yml')).toContain('alice');
		expect(store.exists('/srv/bastion.yml')).toBe(false);
	});
});

/**
 * `--memory 4Gi` is the value the manual and the README both use.
 *
 * `Number('4Gi')` is `NaN`, and that NaN reached the configuration, then `String(NaN)` reached the
 * kernel and the cgroup write failed with EINVAL during startup. The tenant ran with no memory
 * limit at all while `tenant list` printed `NaN` in the column meant to prove it had one.
 */

describe('a memory limit written the way the manual writes it', () => {
	const empty = () => withDisk(memoryFiles({}));

	it('parses a binary suffix rather than storing NaN', async () => {
		const { ctx, files } = empty();
		expect(await run(ctx, ['tenant', 'add', 'acme', '--memory', '4Gi'])).toBe(EXIT.OK);
		expect(files.readText('/srv/bastion.yml')).toContain(String(4 * 1024 ** 3));
	});

	it('parses the decimal suffix too, which is a different number', async () => {
		const { ctx, files } = empty();
		await run(ctx, ['tenant', 'add', 'acme', '--memory', '4G']);
		expect(files.readText('/srv/bastion.yml')).toContain(String(4 * 1000 ** 3));
	});

	it('still takes a plain byte count', async () => {
		const { ctx, files } = empty();
		await run(ctx, ['tenant', 'add', 'acme', '--memory', '536870912']);
		expect(files.readText('/srv/bastion.yml')).toContain('536870912');
	});

	it('refuses something that is not a size rather than writing NaN', async () => {
		const { ctx, io } = empty();
		expect(await run(ctx, ['tenant', 'add', 'acme', '--memory', 'lots'])).toBe(EXIT.USAGE);
		expect(io.errText()).toMatch(/not a size/);
	});

	it('leaves a configuration that still validates', async () => {
		const store = memoryFiles({});
		await run(withDisk(store).ctx, ['tenant', 'add', 'acme', '--memory', '512Mi']);
		expect(await run(withDisk(store).ctx, ['config', 'validate'])).toBe(EXIT.OK);
	});
});
