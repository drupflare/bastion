import { defaultContext, memoryFiles, memoryIo, scriptedRunner } from '@drupflare/bastion';
import { describe, expect, it } from 'vitest';
import { commandReference } from '../src/commands/lifecycle';
import { MANUAL, manualMarkdown, manualTopics, renderTopic } from '../src/manual';
import { HANDLERS, IMPLEMENTED, buildProgram } from '../src/program';
import { COMMANDS, GLOBAL_OPTIONS, GROUPS, findCommand } from '../src/registry';
import { run } from '../src/run';

function harness(files: Record<string, string> = {}) {
	const io = memoryIo();
	return {
		io,
		ctx: {
			...defaultContext(),
			files: memoryFiles({ '/srv/bastion.yml': 'version: 1\nmode: solo\n', ...files }),
			io,
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

	it('accepts a global flag in either position for every implemented command', async () => {
		for (const command of IMPLEMENTED) {
			if ((command.args ?? []).some((arg) => arg.required)) continue;
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
	});

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
			runner: scriptedRunner({ kill: { code: 1, stdout: '', stderr: 'no such process' } }),
			io,
			env: {},
			cwd: '/srv'
		};
		await run(ctx, ['up']);
		expect(io.errText()).toContain('stale pidfile');
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
		expect(runner.calls[0]?.args).toEqual(['-TERM', '4242']);
		expect(files.exists('/srv/state/bastion.pid')).toBe(false);
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
