import { execFile, execFileSync } from 'node:child_process';
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
		spawn: () => {
			throw new Error('the container seam runs and captures; nothing here is long-lived');
		},
		signal: () => {
			throw new Error('the container seam signals nothing');
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
		size: (path) => Number(sh(container, `wc -c < ${quoted(path)}`).trim())
	};
}
