import type { Context } from '@drupflare/bastion';
import {
	BastionError,
	Runtime,
	assertModeSafe,
	bunListenerHost,
	defaultConfig,
	http3Warning,
	modeAvailable,
	preflight,
	resolveBinary,
	socketPaths,
	unixUpstream,
	writeConfig
} from '@drupflare/bastion';
import { MANUAL, manualTopics, renderTopic } from '../manual';
import { COMMANDS, GLOBAL_OPTIONS, type CommandSpec } from '../registry';
import { emit, load, type Globals } from '../state';

export function runInit(ctx: Context, globals: Globals & { force?: boolean }): void {
	const path = globals.config ?? `${ctx.cwd}/bastion.yml`;
	if (ctx.files.exists(path) && globals.force !== true) {
		throw new BastionError('usage', `${path} already exists; pass --force to overwrite it`);
	}
	const config = defaultConfig();
	writeConfig(ctx, path, config);

	// the default state directory needs privileges an `init` may not have. Writing the file and
	// naming what is left to do beats refusing, because the operator now has something to edit
	let state: string | null = null;
	try {
		ctx.files.mkdirp(config.state);
		state = config.state;
	} catch {
		ctx.io.err(
			`could not create ${config.state}. Either run this as a user that can, or set ` +
				'`state:` in the file just written to a directory you own'
		);
	}
	emit(ctx, globals, { wrote: path, state }, () =>
		[
			`wrote ${path}`,
			state === null ? 'the state directory was NOT created' : `state directory ${state}`,
			'',
			'next: bastion doctor'
		].join('\n')
	);
}

/**
 * The checks `up` and `serve` run before anything binds.
 *
 * The mode refusal is here rather than deeper because it must happen before a single tenant starts:
 * a box that came up and then refused would already have served requests under the weaker boundary.
 */
export function preflightForStart(
	ctx: Context,
	globals: Globals & { mode?: string }
): {
	mode: string;
	warnings: string[];
} {
	const loaded = load(ctx, globals);
	const mode = (globals.mode ?? loaded.config.mode) as typeof loaded.config.mode;
	const report = preflight(ctx);
	const availability = modeAvailable(report, mode);
	if (!availability.ok) {
		throw new BastionError('preflight-unsupported', availability.message, {
			next: 'bastion doctor'
		});
	}
	const safety = assertModeSafe(mode, loaded.config.tenants.length, globals.yes === true);
	const warnings: string[] = [];
	if (safety.warned) warnings.push(safety.warning);
	const h3 = http3Warning(loaded.config);
	if (h3 !== null) warnings.push(h3);
	return { mode, warnings };
}

/**
 * Builds the runtime `serve` and `up` both drive.
 *
 * The listener host is resolved at call time rather than imported, so the gate lane typechecks and
 * runs under node with this never called; every spec drives `Runtime` with a recording host.
 */
export function buildRuntime(ctx: Context, globals: Globals & { mode?: string }): Runtime {
	const loaded = load(ctx, globals);
	const config =
		globals.mode === undefined
			? loaded.config
			: { ...loaded.config, mode: globals.mode as typeof loaded.config.mode };
	// a missing binary is not fatal here: the front door still serves and `doctor` says what is
	// absent, which is more useful than refusing to start at all
	let binary: string | null = null;
	try {
		binary = resolveBinary(ctx, {
			state: loaded.state,
			pin: { version: config.runtime.workerd.version },
			floor: config.runtime.floors.workerd,
			verify: config.runtime.workerd.verify
		}).path;
	} catch (e) {
		ctx.io.err(e instanceof Error ? e.message : String(e));
	}
	return new Runtime(ctx, {
		config,
		host: bunListenerHost(),
		upstream: unixUpstream(ctx, socketPaths(loaded.state)),
		acknowledgeUnsafeMode: globals.yes === true,
		...(binary === null ? {} : { binary })
	});
}

export async function runServe(ctx: Context, globals: Globals & { mode?: string }): Promise<void> {
	const loaded = load(ctx, globals);
	const { warnings } = preflightForStart(ctx, globals);
	for (const warning of warnings) ctx.io.err(warning);

	const runtime = buildRuntime(ctx, globals);
	const state = await runtime.up();
	emit(ctx, globals, state, () =>
		[
			`mode ${state.mode}`,
			`${state.tenants.length} tenants running`,
			...state.listeners.map((listener) => `${listener.which} on ${listener.address}`),
			`management on ${loaded.config.listeners.management.address}`
		].join('\n')
	);

	// serve runs in the foreground; a unit file is what restarts it
	await new Promise<void>((resolve) => {
		const stop = (): void => {
			void runtime.down().then(resolve);
		};
		process.once('SIGTERM', stop);
		process.once('SIGINT', stop);
	});
}

export function runManual(
	ctx: Context,
	globals: Globals & { list?: boolean },
	topic?: string
): void {
	if (globals.list === true || topic === undefined) {
		emit(ctx, globals, { topics: manualTopics() }, () =>
			manualTopics()
				.map((entry) => `${entry.id.padEnd(16)}  ${entry.title}`)
				.join('\n')
		);
		return;
	}
	const rendered = renderTopic(topic);
	if (rendered === null) {
		throw new BastionError('usage', `there is no manual topic called ${topic}`, {
			next: 'bastion manual --list'
		});
	}
	ctx.io.out(rendered);
}

export function runCompletion(ctx: Context, _globals: Globals, shell: string): void {
	const names = COMMANDS.map((command) => command.name);
	const roots = [...new Set(names.map((name) => name.split(' ')[0] as string))];
	if (shell === 'bash') {
		ctx.io.out(
			[
				'_bastion_completion() {',
				`  local words="${roots.join(' ')}"`,
				'  COMPREPLY=( $(compgen -W "$words" -- "${COMP_WORDS[COMP_CWORD]}") )',
				'}',
				'complete -F _bastion_completion bastion warden'
			].join('\n')
		);
		return;
	}
	if (shell === 'zsh') {
		ctx.io.out(
			['#compdef bastion warden', `_arguments '1:command:(${roots.join(' ')})'`].join('\n')
		);
		return;
	}
	if (shell === 'fish') {
		ctx.io.out(
			roots
				.map((root) => `complete -c bastion -n "__fish_use_subcommand" -a ${root}`)
				.join('\n')
		);
		return;
	}
	throw new BastionError('usage', `no completion script for ${shell}; try bash, zsh or fish`);
}

/**
 * The reference `docs:cli` writes and CI compares against.
 *
 * Takes the list of commands that actually have an implementation rather than reading the whole
 * table, so the reference never documents something that answers an error.
 */
export function commandReference(specs: CommandSpec[]): string {
	const lines: string[] = [
		'# Commands',
		'',
		'Generated from the command definitions by `bun run docs:cli`. CI fails when it drifts, so',
		'this file cannot disagree with the program.',
		'',
		'## Global Flags',
		'',
		'| flag | meaning |',
		'| --- | --- |',
		...GLOBAL_OPTIONS.map((option) => `| \`${option.flags}\` | ${option.description} |`),
		'',
		'## Exit Codes',
		'',
		'| code | meaning |',
		'| --- | --- |',
		'| 0 | it worked |',
		'| 1 | it could not run |',
		'| 2 | the input or the configuration is wrong |',
		'| 3 | it ran and found something |',
		''
	];

	const groups = [...new Set(specs.map((command) => command.group))];
	for (const group of groups) {
		lines.push(`## ${group.charAt(0).toUpperCase()}${group.slice(1)}`, '');
		for (const command of specs.filter((command) => command.group === group)) {
			const args = (command.args ?? [])
				.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`))
				.join(' ');
			lines.push(`### \`bastion ${command.name}${args === '' ? '' : ` ${args}`}\``, '');
			lines.push(command.description, '');
			if ((command.args ?? []).length > 0) {
				lines.push('| argument | required | meaning |', '| --- | --- | --- |');
				for (const arg of command.args ?? []) {
					lines.push(
						`| \`${arg.name}\` | ${arg.required ? 'yes' : 'no'} | ${arg.description} |`
					);
				}
				lines.push('');
			}
			if ((command.options ?? []).length > 0) {
				lines.push('| flag | meaning |', '| --- | --- |');
				for (const option of command.options ?? []) {
					lines.push(`| \`${option.flags}\` | ${option.description} |`);
				}
				lines.push('');
			}
			lines.push(`Documented in \`bastion manual ${command.manual}\`.`, '');
		}
	}
	return `${lines.join('\n').trimEnd()}\n`;
}

export { MANUAL };

function pidFile(state: string): string {
	return `${state}/bastion.pid`;
}

/**
 * Starts `serve` in the background and records its pid.
 *
 * A pidfile rather than a socket handshake, because the thing `down` has to reach may be wedged,
 * and a wedged process still has a pid. The file is removed by `down` rather than by the process,
 * so a crash leaves it behind and `up` can tell a stale one from a live one.
 */
export async function runUp(
	ctx: Context,
	globals: Globals & { mode?: string; dashboard?: boolean }
): Promise<number> {
	const loaded = load(ctx, globals);
	const path = pidFile(loaded.state);
	if (ctx.files.exists(path)) {
		const existing = Number(ctx.files.readText(path).trim());
		const alive = await ctx.runner.run('kill', ['-0', String(existing)]);
		if (alive.code === 0) {
			ctx.io.err(`bastion is already running as pid ${existing}`);
			return 2;
		}
		ctx.io.err(`removing a stale pidfile for ${existing}`);
		ctx.files.remove(path);
	}

	// the preflight runs HERE rather than in the child, so a refusal reaches the operator's
	// terminal instead of a log file they have not opened yet
	const { warnings } = preflightForStart(ctx, globals);
	for (const warning of warnings) ctx.io.err(warning);

	const argv = ['serve'];
	if (globals.mode !== undefined) argv.push('--mode', globals.mode);
	if (globals.config !== undefined) argv.push('--config', globals.config);
	const started = ctx.runner.spawn(process.execPath, argv);
	if (started.pid !== null) ctx.files.writeText(path, String(started.pid));

	emit(ctx, globals, { pid: started.pid, state: loaded.state, warnings }, () =>
		[
			`bastion is running as pid ${started.pid ?? '(unknown)'}`,
			globals.dashboard === false
				? 'the dashboard was not started'
				: `dashboard on ${loaded.config.listeners.management.address}`
		].join('\n')
	);
	return 0;
}

export async function runDown(ctx: Context, globals: Globals): Promise<number> {
	const loaded = load(ctx, globals);
	const path = pidFile(loaded.state);
	if (!ctx.files.exists(path)) {
		ctx.io.err('bastion is not running, or it was not started with `bastion up`');
		return 2;
	}
	const pid = Number(ctx.files.readText(path).trim());
	await ctx.runner.run('kill', ['-TERM', String(pid)]);
	ctx.files.remove(path);
	emit(ctx, globals, { stopped: pid }, () => `asked pid ${pid} to stop`);
	return 0;
}

export async function runRestart(
	ctx: Context,
	globals: Globals & { mode?: string }
): Promise<number> {
	await runDown(ctx, globals);
	return runUp(ctx, globals);
}
