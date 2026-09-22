import { execFile, execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { CommandRunner } from '../../../src/host/exec';
import { memoryFiles, type FileHost } from '../../../src/host/files';

/**
 * The two host seams, pointed into a running container.
 *
 * An adapter that drives a binary and reads what it wrote needs both halves in the same place. A
 * bind mount would put them there too, and it would also put a host path and its permissions into
 * every CI job; `docker exec` needs neither, and it is the substitution the `Context` seam exists
 * for. What runs is the adapter's own argv against the real program.
 */
const run = promisify(execFile);

export function containerRunner(container: string): CommandRunner {
	return {
		run: async (command, args, options) => {
			const argv = ['exec', container, command, ...args];
			try {
				const { stdout, stderr } = await run('docker', argv, {
					maxBuffer: 64 * 1024 * 1024,
					...(options?.timeoutMs === undefined ? {} : { timeout: options.timeoutMs })
				});
				return { code: 0, stdout, stderr };
			} catch (error) {
				const failure = error as { code?: number; stdout?: string; stderr?: string };
				return {
					code: failure.code ?? 1,
					stdout: failure.stdout ?? '',
					stderr: failure.stderr ?? ''
				};
			}
		},
		/**
		 * A microVM outlives the call that started it, so this seam cannot only capture.
		 *
		 * `docker exec` streams the container process's output to this host child, so `logFile` is
		 * a HOST path and the guest's console lands somewhere the spec can read it.
		 */
		spawn: (command, args, options = {}) => {
			const log =
				options.logFile === undefined
					? null
					: (mkdirSync(dirname(options.logFile), { recursive: true }),
						openSync(options.logFile, 'a'));
			const child = nodeSpawn('docker', ['exec', container, command, ...args], {
				stdio: log === null ? 'ignore' : ['ignore', log, log]
			});
			if (log !== null) closeSync(log);
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
		/** the host pid belongs to `docker exec`, so a signal has to reach inside the container */
		signal: (pid, signal) => {
			try {
				execFileSync('docker', ['exec', container, 'kill', `-${signal}`, String(pid)]);
				return 'delivered';
			} catch {
				return 'gone';
			}
		}
	};
}

/** base64 rather than a text pipe, because a screenshot is bytes and a locale is not */
const sh = (container: string, script: string, input?: Buffer): string =>
	execFileSync('docker', ['exec', '-i', container, 'sh', '-c', script], {
		...(input === undefined ? {} : { input }),
		maxBuffer: 64 * 1024 * 1024
	}).toString();

/**
 * The paths the browser adapter touches, inside the container; everything else stays in memory.
 *
 * Only the methods a render reaches are real, which is the honest shape: a spec that implemented
 * the whole interface over `docker exec` would be claiming coverage of paths it never drives.
 */
export function containerFiles(container: string): FileHost {
	const quoted = (path: string): string => `'${path.replace(/'/g, `'\\''`)}'`;
	return {
		...memoryFiles(),
		exists: (path) => {
			try {
				sh(container, `test -e ${quoted(path)}`);
				return true;
			} catch {
				return false;
			}
		},
		mkdirp: (path) => void sh(container, `mkdir -p ${quoted(path)}`),
		writeText: (path, contents) =>
			void sh(container, `cat > ${quoted(path)}`, Buffer.from(contents, 'utf8')),
		writeBytes: (path, contents) =>
			void sh(
				container,
				`base64 -d > ${quoted(path)}`,
				Buffer.from(Buffer.from(contents).toString('base64'))
			),
		readText: (path) => sh(container, `cat ${quoted(path)}`),
		readBytes: (path) =>
			new Uint8Array(Buffer.from(sh(container, `base64 ${quoted(path)}`), 'base64')),
		remove: (path) => void sh(container, `rm -f ${quoted(path)}`),
		size: (path) => Number(sh(container, `wc -c < ${quoted(path)}`).trim()),
		isDirectory: (path) => {
			try {
				sh(container, `test -d ${quoted(path)}`);
				return true;
			} catch {
				return false;
			}
		},
		// the permission and ownership calls have to reach the container too: a jailer reads the
		// real mode off the real chroot, so leaving these on the memory host would assert nothing
		mode: (path) => {
			try {
				return parseInt(sh(container, `stat -c %a ${quoted(path)}`).trim(), 8);
			} catch {
				return null;
			}
		},
		chmod: (path, mode) =>
			void sh(container, `chmod ${mode.toString(8).padStart(4, '0')} ${quoted(path)}`),
		link: (source, dest) =>
			void sh(
				container,
				`ln -f ${quoted(source)} ${quoted(dest)} 2>/dev/null || cp -f ${quoted(source)} ${quoted(dest)}`
			),
		owner: (path) => {
			try {
				const [uid, gid] = sh(container, `stat -c %u:%g ${quoted(path)}`)
					.trim()
					.split(':');
				return { uid: Number(uid), gid: Number(gid) };
			} catch {
				return null;
			}
		},
		chown: (path, uid, gid) => void sh(container, `chown ${uid}:${gid} ${quoted(path)}`),
		realpath: (path) => {
			try {
				return sh(container, `readlink -f ${quoted(path)}`).trim() || path;
			} catch {
				return path;
			}
		}
	};
}
