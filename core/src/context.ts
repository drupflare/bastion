import { nodeRunner, type CommandRunner } from './host/exec';
import { nodeFiles, type FileHost } from './host/files';
import { consoleIo, type Io } from './io';

/**
 * Everything a command may touch outside its own process.
 *
 * Commands take a context and nothing else, so the gate lane substitutes all of it and no unit
 * test contacts a network, a host, a cgroup or a hypervisor.
 */
export interface Context {
	io: Io;
	files: FileHost;
	runner: CommandRunner;
	fetch: typeof globalThis.fetch;
	env: NodeJS.ProcessEnv;
	cwd: string;
	/**
	 * What this host is, as `process.platform` names it.
	 *
	 * A seam because the preflight and every mode decision branch on it, and the gate lane has to
	 * drive both sides of a refusal that only fires on one kind of host. Reading `process.platform`
	 * directly left the linux paths reachable only from a linux runner.
	 */
	platform: string;
	/** milliseconds since the epoch; a seam so a spec can freeze it */
	now(): number;
}

export function defaultContext(): Context {
	return {
		io: consoleIo(),
		files: nodeFiles(),
		runner: nodeRunner(),
		fetch: globalThis.fetch.bind(globalThis),
		env: process.env,
		cwd: process.cwd(),
		platform: process.platform,
		now: () => Date.now()
	};
}
