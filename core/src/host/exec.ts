import type { ChildProcess } from 'node:child_process';
import { execFile, spawn as nodeSpawn } from 'node:child_process';

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	/** bytes written to the child's stdin before it is closed */
	input?: string;
}

/** a started process the supervisor holds */
export interface Started {
	pid: number | null;
	/** resolves with the exit code when the process ends */
	exited: Promise<number>;
	kill(signal?: NodeJS.Signals): void;
}

/**
 * The subprocess seam.
 *
 * **`run` captures and `spawn` inherits, and which one a call takes is decided by what the OUTPUT
 * is for.** `run` when the caller parses it: a digest, a version string, an `nft list`. `spawn`
 * when the process is long-lived or the user watches it: workerd itself, a firecracker guest, an
 * ssh install. Both land in one ordered ledger on the scripted implementation, tagged `mode`, so
 * a spec asserts step order across the two.
 *
 * `execFile`, never a shell, so no argument is word-split.
 */
export interface CommandRunner {
	run(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
	spawn(command: string, args: string[], options?: RunOptions): Started;
}

export function nodeRunner(): CommandRunner {
	return {
		run: (command, args, options = {}) =>
			new Promise((resolve) => {
				const child = execFile(
					command,
					args,
					{
						cwd: options.cwd,
						env:
							options.env === undefined
								? process.env
								: { ...process.env, ...options.env },
						timeout: options.timeoutMs ?? 60_000,
						maxBuffer: 64 * 1024 * 1024,
						encoding: 'utf8'
					},
					(error, stdout, stderr) => {
						const code =
							error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
						resolve({ code, stdout: String(stdout), stderr: String(stderr) });
					}
				);
				if (options.input !== undefined) {
					child.stdin?.end(options.input);
				}
			}),
		spawn: (command, args, options = {}) => {
			const child: ChildProcess = nodeSpawn(command, args, {
				cwd: options.cwd,
				env: options.env === undefined ? process.env : { ...process.env, ...options.env },
				stdio: 'inherit'
			});
			return {
				pid: child.pid ?? null,
				exited: new Promise<number>((resolve) => {
					child.on('exit', (code) => resolve(code ?? 1));
					child.on('error', () => resolve(1));
				}),
				kill: (signal) => {
					child.kill(signal ?? 'SIGTERM');
				}
			};
		}
	};
}

/** one call the scripted runner recorded */
export interface RecordedCall {
	mode: 'run' | 'spawn';
	command: string;
	args: string[];
	options: RunOptions;
}

export interface ScriptedRunner extends CommandRunner {
	/** every call in the order it was made, across both modes */
	readonly calls: RecordedCall[];
}

/**
 * A runner that answers from a script, for the gate lane.
 *
 * A handler is matched on the command plus its joined args, most specific first; an unmatched
 * call answers `{code: 0}` with empty output rather than throwing, so a spec asserts what it
 * cares about without stubbing everything a code path happens to touch.
 */
export function scriptedRunner(
	handlers: Record<string, RunResult | ((args: string[]) => RunResult)> = {}
): ScriptedRunner {
	const calls: RecordedCall[] = [];
	const answer = (command: string, args: string[]): RunResult => {
		const full = [command, ...args].join(' ');
		const keys = Object.keys(handlers).sort((a, b) => b.length - a.length);
		for (const key of keys) {
			if (full === key || full.startsWith(`${key} `) || command === key) {
				const handler = handlers[key];
				return typeof handler === 'function' ? handler(args) : (handler as RunResult);
			}
		}
		return { code: 0, stdout: '', stderr: '' };
	};
	return {
		calls,
		run: async (command, args, options = {}) => {
			calls.push({ mode: 'run', command, args, options });
			return answer(command, args);
		},
		spawn: (command, args, options = {}) => {
			calls.push({ mode: 'spawn', command, args, options });
			const result = answer(command, args);
			return {
				pid: 4242,
				exited: Promise.resolve(result.code),
				kill: () => {}
			};
		}
	};
}
