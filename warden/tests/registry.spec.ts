import {
	ACKNOWLEDGE_FLAG,
	defaultContext,
	memoryFiles,
	memoryIo,
	scriptedRunner
} from '@drupflare/bastion';
import { describe, expect, it } from 'vitest';
import { commandReference } from '../src/commands/lifecycle';
import { MANUAL, manualMarkdown, manualTopics, renderTopic } from '../src/manual';
import { HANDLERS, IMPLEMENTED, buildProgram } from '../src/program';
import { COMMANDS, GLOBAL_OPTIONS, GROUPS, findCommand } from '../src/registry';
import { run } from '../src/run';

/**
 * A context with every outward seam substituted, including the two `defaultContext` still holds.
 *
 * Spreading it and overriding only files and io leaves `nodeRunner` and the real `fetch` in place,
 * so a handler that probes the host runs real subprocesses from the gate lane. `capability list`
 * shells out to six of them, which passes on a laptop that has none and hung past the 5s timeout
 * on a runner that does.
 */
function harness(files: Record<string, string> = {}) {
	const io = memoryIo();
	return {
		io,
		ctx: {
			...defaultContext(),
			files: memoryFiles({ '/srv/bastion.yml': 'version: 1\nmode: solo\n', ...files }),
			io,
			runner: scriptedRunner(),
			fetch: () => Promise.reject(new Error('the gate lane reaches no network')),
			env: {},
			cwd: '/srv'
		}
	};
}

describe('the command table', () => {
	it('gives every command a group, a description and a manual topic', () => {
		for (const command of COMMANDS) {
			expect(command.group).toBeTruthy();
			expect(command.description.length).toBeGreaterThan(8);
			expect(command.manual).toBeTruthy();
		}
	});

	it('has no duplicate names', () => {
		const names = COMMANDS.map((command) => command.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it('names a manual topic that exists, for every command', () => {
		const topics = new Set(MANUAL.map((section) => section.id));
		for (const command of COMMANDS) expect(topics.has(command.manual)).toBe(true);
	});

	it('declares every group at least once', () => {
		for (const group of GROUPS) {
			expect(COMMANDS.some((command) => command.group === group)).toBe(true);
		}
	});

	it('finds a command by name', () => {
		expect(findCommand('config show')?.group).toBe('config');
		expect(findCommand('nope')).toBe(null);
	});
});

describe('handlers and the table agree', () => {
	it('has a table entry for every handler, so nothing runs undocumented', () => {
		const names = new Set(COMMANDS.map((command) => command.name));
		for (const name of Object.keys(HANDLERS)) expect(names.has(name)).toBe(true);
	});

	it('registers exactly the commands that have a handler', () => {
		for (const command of IMPLEMENTED) expect(HANDLERS[command.name]).toBeDefined();
		expect(IMPLEMENTED).toHaveLength(Object.keys(HANDLERS).length);
	});
});

describe('the program', () => {
	it('registers every implemented command and nothing else', () => {
		const { ctx } = harness();
		const program = buildProgram(ctx);
		const registered: string[] = [];
		const walk = (command: { commands: unknown[]; name(): string }, prefix: string): void => {
			for (const raw of command.commands) {
				const child = raw as { commands: unknown[]; name(): string };
				const name = `${prefix}${child.name()}`;
				if (child.commands.length === 0) registered.push(name);
				else walk(child, `${name} `);
			}
		};
		walk(program as unknown as { commands: unknown[]; name(): string }, '');
		expect(registered.sort()).toEqual(IMPLEMENTED.map((c) => c.name).sort());
	});

	/**
	 * One case per command rather than one loop over all of them.
	 *
	 * Every case builds the whole 125-command program twice, so the loop form was a single test
	 * doing 250 of them: 190ms here and over the 5s timeout on a two-core runner sharing itself
	 * with the other vitest workers. Splitting bounds each case at two builds and names the command
	 * that failed instead of the loop that contained it.
	 */
	it.each(IMPLEMENTED.filter((command) => !(command.args ?? []).some((arg) => arg.required)))(
		'accepts a global flag in either position for $name',
		async (command) => {
			const first = harness();
			const second = harness();
			const path = command.name.split(' ');
			await run(first.ctx, ['--json', ...path]);
			await run(second.ctx, [...path, '--json']);
			expect(first.io.errText(), `${command.name} failed with --json first`).not.toContain(
				'unknown option'
			);
			expect(second.io.errText(), `${command.name} failed with --json last`).not.toContain(
				'unknown option'
			);
		}
	);

	it('exits 2 for a command that does not exist rather than doing nothing', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['nonsense'])).toBeGreaterThan(0);
	});
});

describe('the manual', () => {
	it('gives every section an id, a title and a body', () => {
		for (const section of MANUAL) {
			expect(section.id).toMatch(/^[a-z-]+$/);
			expect(section.title.length).toBeGreaterThan(2);
			expect(section.body.length).toBeGreaterThan(100);
		}
	});

	it('has no duplicate ids', () => {
		const ids = MANUAL.map((section) => section.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('renders a topic by id or by title', () => {
		expect(renderTopic('tls')).toContain('workerd cannot do SNI');
		expect(renderTopic('TLS')).toContain('workerd cannot do SNI');
	});

	it('answers null for a topic it does not have', () => {
		expect(renderTopic('quantum')).toBe(null);
	});

	it('lists every topic', () => {
		expect(manualTopics()).toHaveLength(MANUAL.length);
	});

	it('renders the same sections to markdown', () => {
		const markdown = manualMarkdown();
		for (const section of MANUAL) expect(markdown).toContain(`## ${section.title}`);
	});

	it('states plainly that solo and hardened are not safe for untrusted tenants', () => {
		expect(renderTopic('isolation')).toContain('Only `isolated` is multi-tenant safe');
	});
});

describe('the generated reference', () => {
	it('documents every implemented command', () => {
		const reference = commandReference(IMPLEMENTED);
		for (const command of IMPLEMENTED) expect(reference).toContain(`bastion ${command.name}`);
	});

	it('documents nothing that has no implementation', () => {
		const reference = commandReference(IMPLEMENTED);
		const unimplemented = COMMANDS.filter((command) => HANDLERS[command.name] === undefined);
		for (const command of unimplemented) {
			expect(reference).not.toContain(`### \`bastion ${command.name}\``);
		}
	});

	it('documents every global flag and the closed exit set', () => {
		const reference = commandReference(IMPLEMENTED);
		for (const option of GLOBAL_OPTIONS) expect(reference).toContain(option.flags);
		for (const code of ['| 0 |', '| 1 |', '| 2 |', '| 3 |']) expect(reference).toContain(code);
	});
});

describe('lifecycle commands', () => {
	it('refuses to start twice, and says which pid already holds it', async () => {
		const io = memoryIo();
		const runner = scriptedRunner({ kill: { code: 0, stdout: '', stderr: '' } });
		const ctx = {
			...defaultContext(),
			files: memoryFiles({
				'/srv/bastion.yml': 'version: 1\nstate: /srv/state\n',
				'/srv/state/bastion.pid': '4242'
			}),
			runner,
			io,
			env: {},
			cwd: '/srv'
		};
		expect(await run(ctx, ['up'])).toBe(2);
		expect(io.errText()).toContain('already running as pid 4242');
	});

	it('clears a stale pidfile rather than refusing forever', async () => {
		const io = memoryIo();
		const files = memoryFiles({
			'/srv/bastion.yml': 'version: 1\nstate: /srv/state\n',
			'/srv/state/bastion.pid': '4242'
		});
		const ctx = {
			...defaultContext(),
			files,
			runner: scriptedRunner({ signal: { code: 1, stdout: '', stderr: 'no such process' } }),
			io,
			env: {},
			cwd: '/srv'
		};
		await run(ctx, ['up']);
		expect(io.errText()).toContain('stale pidfile');
	});

	/**
	 * `up` spawned `serve` with inherited stdio, so it never exited.
	 *
	 * The child holds the parent's stdout and stderr, and a process that is meant to outlive its
	 * parent holding the other end of a pipe means nothing reading that output ever gets EOF. An
	 * interactive shell hid it, because a tty is not a pipe; `timeout 30 bastion up` in a container
	 * printed `bastion is running as pid 541` and then exited 124.
	 */
	/** `up` gets past the preflight only on a host that can run the mode, so the seam says linux */
	function startable(runner = scriptedRunner()) {
		const io = memoryIo();
		return {
			io,
			runner,
			ctx: {
				...defaultContext(),
				files: memoryFiles({
					'/srv/bastion.yml': 'version: 1\nstate: /srv/state\n',
					'/sys/fs/cgroup/cgroup.controllers': 'cpu memory pids'
				}),
				runner,
				io,
				env: {},
				cwd: '/srv',
				platform: 'linux'
			}
		};
	}

	it('detaches the serve child to a log file rather than the caller s pipes', async () => {
		const { ctx, runner } = startable();
		await run(ctx, ['up']);
		const spawned = runner.calls.find((call) => call.mode === 'spawn');
		expect(spawned?.options.logFile).toBe('/srv/state/logs/serve.log');
	});

	/**
	 * The multi-tenant refusal names a flag, and that flag has to exist.
	 *
	 * It told the operator to pass `--i-understand-this-is-not-multi-tenant-safe` and no command
	 * registered it, so following the instruction answered `unknown option` and the escape hatch the
	 * message promised was unreachable. Measured through the compiled binary in a container.
	 */
	function twoTenants(argv: string[]) {
		const io = memoryIo();
		return {
			io,
			ctx: {
				...defaultContext(),
				files: memoryFiles({
					'/srv/bastion.yml':
						'version: 1\nstate: /srv/state\ntenants:\n  - name: a\n    sites: []\n' +
						'  - name: b\n    sites: []\n',
					'/sys/fs/cgroup/cgroup.controllers': 'cpu memory pids'
				}),
				runner: scriptedRunner(),
				io,
				env: {},
				cwd: '/srv',
				platform: 'linux'
			},
			argv
		};
	}

	it('refuses two tenants in solo, and names a flag that parses', async () => {
		const refused = twoTenants(['up']);
		expect(await run(refused.ctx, refused.argv)).toBe(2);
		expect(refused.io.errText()).toContain('not multi-tenant safe');

		const named = twoTenants(['up', ACKNOWLEDGE_FLAG]);
		expect(await run(named.ctx, named.argv)).not.toBe(2);
		expect(named.io.errText()).not.toContain('unknown option');
	});

	it('takes the acknowledgement on serve and restart too', async () => {
		for (const command of ['serve', 'restart']) {
			const { ctx, io, argv } = twoTenants([command, ACKNOWLEDGE_FLAG]);
			await run(ctx, argv);
			expect(io.errText(), command).not.toContain('unknown option');
		}
	});

	/**
	 * `up` has to pass it on, because the child is the process that starts the tenants.
	 *
	 * It accepted the flag, printed the warning, and spawned a `serve` nobody had told, which
	 * refused: `bastion exited 2 during startup`. The acknowledgement reached the parent and died
	 * there.
	 */
	it('forwards the acknowledgement to the serve it spawns', async () => {
		const runner = scriptedRunner();
		const { ctx, argv } = twoTenants(['up', ACKNOWLEDGE_FLAG]);
		ctx.runner = runner;
		await run(ctx, argv);
		const spawned = runner.calls.find((call) => call.mode === 'spawn');
		expect(spawned?.args).toContain(ACKNOWLEDGE_FLAG);
	});

	it('does not forward it when it was not given', async () => {
		const runner = scriptedRunner();
		const { ctx, argv } = twoTenants(['up']);
		ctx.runner = runner;
		await run(ctx, argv);
		const spawned = runner.calls.find((call) => call.mode === 'spawn');
		expect(spawned?.args ?? []).not.toContain(ACKNOWLEDGE_FLAG);
	});

	/** `--yes` is typed reflexively in a script; a security boundary should not ride on it */
	it('does not let --yes stand in for the acknowledgement', async () => {
		const { ctx, io, argv } = twoTenants(['up', '--yes']);
		expect(await run(ctx, argv)).toBe(2);
		expect(io.errText()).toContain('not multi-tenant safe');
	});

	// the success path waits out the whole startup grace, so it is asserted in the serving lane
	// where a real `up` runs anyway rather than costing this one 1.5s of its 2s budget

	it('names it in the refusal too, when the child dies during startup', async () => {
		const { ctx, io } = startable(
			scriptedRunner({ serve: { code: 2, stdout: '', stderr: '' } })
		);
		expect(await run(ctx, ['up'])).toBe(1);
		expect(io.errText()).toContain('/srv/state/logs/serve.log');
	});

	/**
	 * A refusal inside `serve` has to reach the terminal, not only the log.
	 *
	 * Detaching the child sent its stderr to a file, so `bastion up` against a missing certificate
	 * said `bastion exited 2 during startup` and nothing else: the operator had to open a file to
	 * learn which setting was wrong. The child is dead by then, so the log is complete.
	 */
	it('puts what the child said back on the terminal', async () => {
		const { ctx, io } = startable(
			scriptedRunner({ serve: { code: 2, stdout: '', stderr: '' } })
		);
		ctx.files.writeText(
			'/srv/state/logs/serve.log',
			'the https listener has no certificate\nnext: bastion cert issue\n'
		);
		await run(ctx, ['up']);
		expect(io.errText()).toContain('no certificate');
		expect(io.errText()).toContain('bastion cert issue');
	});

	it('shows the tail rather than a whole crash loop', async () => {
		const { ctx, io } = startable(
			scriptedRunner({ serve: { code: 2, stdout: '', stderr: '' } })
		);
		const lines = Array.from({ length: 40 }, (_unused, at) => `line ${at}`);
		ctx.files.writeText('/srv/state/logs/serve.log', `${lines.join('\n')}\n`);
		await run(ctx, ['up']);
		expect(io.errText()).toContain('line 39');
		expect(io.errText()).not.toContain('line 0\n');
	});

	it('says plainly that nothing is running rather than exiting 0', async () => {
		const io = memoryIo();
		const ctx = {
			...defaultContext(),
			files: memoryFiles({ '/srv/bastion.yml': 'version: 1\nstate: /srv/state\n' }),
			runner: scriptedRunner(),
			io,
			env: {},
			cwd: '/srv'
		};
		expect(await run(ctx, ['down'])).toBe(2);
		expect(io.errText()).toContain('not running');
	});

	it('signals the recorded pid and forgets the file', async () => {
		const io = memoryIo();
		const files = memoryFiles({
			'/srv/bastion.yml': 'version: 1\nstate: /srv/state\n',
			'/srv/state/bastion.pid': '4242'
		});
		const runner = scriptedRunner();
		const ctx = { ...defaultContext(), files, runner, io, env: {}, cwd: '/srv' };
		expect(await run(ctx, ['down'])).toBe(0);
		expect(runner.calls[0]).toMatchObject({ mode: 'signal', args: ['SIGTERM', '4242'] });
		expect(files.exists('/srv/state/bastion.pid')).toBe(false);
	});

	/**
	 * `down` used to shell out to `kill` and ignore its exit code.
	 *
	 * `kill` is a shell builtin and debian ships the binary in `procps`, which a slim image does
	 * not install, so `execFile` failed ENOENT on every stop: the pidfile went away, the operator
	 * read `asked pid N to stop`, and every workerd bastion had started kept running.
	 */
	it('signals through the runner rather than shelling out to a kill binary', async () => {
		const io = memoryIo();
		const files = memoryFiles({
			'/srv/bastion.yml': 'version: 1\nstate: /srv/state\n',
			'/srv/state/bastion.pid': '4242'
		});
		const runner = scriptedRunner();
		const ctx = { ...defaultContext(), files, runner, io, env: {}, cwd: '/srv' };
		await run(ctx, ['down']);
		expect(runner.calls.map((call) => call.command)).not.toContain('kill');
	});

	it('says so rather than claiming a stop when the process had already exited', async () => {
		const io = memoryIo();
		const files = memoryFiles({
			'/srv/bastion.yml': 'version: 1\nstate: /srv/state\n',
			'/srv/state/bastion.pid': '4242'
		});
		const runner = scriptedRunner({ signal: { code: 1, stdout: '', stderr: '' } });
		const ctx = { ...defaultContext(), files, runner, io, env: {}, cwd: '/srv' };
		expect(await run(ctx, ['down'])).toBe(0);
		expect(io.outText()).toContain('already exited');
	});

	/** the pidfile is the only handle on a process this user may not signal, so it stays */
	it('keeps the pidfile when the signal is refused', async () => {
		const io = memoryIo();
		const files = memoryFiles({
			'/srv/bastion.yml': 'version: 1\nstate: /srv/state\n',
			'/srv/state/bastion.pid': '4242'
		});
		const runner = scriptedRunner({ signal: { code: 1, stdout: 'refused', stderr: '' } });
		const ctx = { ...defaultContext(), files, runner, io, env: {}, cwd: '/srv' };
		expect(await run(ctx, ['down'])).toBe(1);
		expect(files.exists('/srv/state/bastion.pid')).toBe(true);
	});
});

describe('site rm', () => {
	function tree(config: string) {
		const io = memoryIo();
		return {
			io,
			ctx: {
				...defaultContext(),
				files: memoryFiles({ '/srv/bastion.yml': config }),
				runner: scriptedRunner(),
				io,
				env: {},
				cwd: '/srv'
			}
		};
	}

	const config = [
		'version: 1',
		'mode: solo',
		'tenants:',
		'  - name: acme',
		'    sites:',
		'      - host: a.example.edu',
		'        bundle: ./p',
		'        probe: drupflare',
		'  - name: labs',
		'    sites:',
		'      - host: b.example.edu',
		'        bundle: ./p',
		'        probe: drupflare',
		''
	].join('\n');

	it('refuses a host nothing holds rather than reporting success for a typo', async () => {
		const { ctx, io } = tree(config);
		expect(await run(ctx, ['site', 'rm', 'typo.example.edu'])).toBe(2);
		expect(io.errText()).toContain('no tenant holds');
	});

	it('removes from the owning tenant only, leaving every other tenant untouched', async () => {
		const { ctx } = tree(config);
		expect(await run(ctx, ['site', 'rm', 'a.example.edu'])).toBe(0);
		const written = ctx.files.readText('/srv/bastion.yml');
		expect(written).not.toContain('a.example.edu');
		expect(written).toContain('b.example.edu');
	});

	it('says the certificate is left behind rather than leaving it to be discovered', async () => {
		const { ctx, io } = tree(config);
		await run(ctx, ['site', 'rm', 'a.example.edu']);
		expect(io.errText()).toContain('certificate');
	});
});
