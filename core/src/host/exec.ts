import type { ChildProcess } from 'node:child_process';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

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
	/**
	 * Detaches a spawned process and appends its output to this file instead of the caller's.
	 *
	 * **`bastion up` never returned without this.** `spawn` inherits, so the backgrounded `serve`
	 * held the parent's stdout and stderr; the parent printed `bastion is running as pid N` and then
	 * waited forever for a child that is supposed to outlive it. An interactive shell hid it,
	 * because a tty is not a pipe, so it only showed up under the things an IT department actually
	 * uses: a provisioning script, `ssh box bastion up`, a CI step, `docker exec`.
	 */
	logFile?: string;
}

/** a started process the supervisor holds */
export interface Started {
	pid: number | null;
	/** resolves with the exit code when the process ends */
	exited: Promise<number>;
	kill(signal?: NodeJS.Signals): void;
}

/**
 * What a signal did, because all three outcomes need different words from a command.
 *
 * `gone` is the process already having exited, which makes a stop a no-op rather than a failure;
 * `refused` is EPERM, where something is still running and bastion may not touch it, so the caller
 * keeps the pidfile instead of throwing away its only handle on it.
 */
export type SignalResult = 'delivered' | 'gone' | 'refused';

/**
 * The subprocess seam.
 *
 * **`run` captures and `spawn` inherits, and which one a call takes is decided by what the OUTPUT
 * is for.** `run` when the caller parses it: a digest, a version string, an `nft list`. `spawn`
 * when the process is long-lived or the user watches it: workerd itself, a firecracker guest, an
 * ssh install. Both land in one ordered ledger on the scripted implementation, tagged `mode`, so
 * a spec asserts step order across the two.
 *
 * `signal` is here rather than as a `kill` argv because **`kill` is a shell builtin and frequently
 * not a binary at all**: debian ships it in `procps`, which a slim image does not install, so
 * `execFile('kill', ...)` fails ENOENT while `command -v kill` still answers. `bastion down`
 * shelled out that way, ignored the exit code, removed the pidfile and reported the tenant
 * stopped, and every workerd it had started stayed up.
 *
 * `execFile`, never a shell, so no argument is word-split.
 */
export interface CommandRunner {
	run(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
	spawn(command: string, args: string[], options?: RunOptions): Started;
	/** signal 0 delivers nothing and answers whether the process is there, which is the liveness probe */
	signal(pid: number, signal: NodeJS.Signals | 0): SignalResult;
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
			const log =
				options.logFile === undefined
					? null
					: (mkdirSync(dirname(options.logFile), { recursive: true }),
						openSync(options.logFile, 'a'));
			const child: ChildProcess = nodeSpawn(command, args, {
				cwd: options.cwd,
				env: options.env === undefined ? process.env : { ...process.env, ...options.env },
				...(log === null
					? { stdio: 'inherit' }
					: { stdio: ['ignore', log, log], detached: true })
			});
			// the parent must be able to exit while this one keeps running, and the descriptor is
			// the child's now
			if (log !== null) {
				child.unref();
				closeSync(log);
			}
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
		},
		signal: (pid, signal) => {
			try {
				process.kill(pid, signal);
				return 'delivered';
			} catch (error) {
				return (error as { code?: string }).code === 'ESRCH' ? 'gone' : 'refused';
			}
		}
	};
}

/** one call the scripted runner recorded */
export interface RecordedCall {
	mode: 'run' | 'spawn' | 'signal';
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
		},
		// scripted as `signal <sig>`, so a spec makes a pid gone or a stop refused through the one
		// handler map the other two modes already answer from
		signal: (pid, signal) => {
			const args = [String(signal), String(pid)];
			calls.push({ mode: 'signal', command: 'signal', args, options: {} });
			const result = answer('signal', args);
			if (result.code === 0) return 'delivered';
			return result.stdout === 'refused' ? 'refused' : 'gone';
		}
	};
}
