/**
 * The output seam.
 *
 * **Stdout carries the report object and nothing else.** Progress, warnings and every human line
 * go to stderr, so `--json | jq` works on the success path and the failure path alike. A command
 * that prints a prose line to stdout before throwing breaks every caller that parses it.
 */
export interface Io {
	out(line: string): void;
	err(line: string): void;
}

export function consoleIo(): Io {
	return {
		out: (line) => process.stdout.write(`${line}\n`),
		err: (line) => process.stderr.write(`${line}\n`)
	};
}

export interface MemoryIo extends Io {
	readonly stdout: string[];
	readonly stderr: string[];
	outText(): string;
	errText(): string;
}

export function memoryIo(): MemoryIo {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		out: (line) => stdout.push(line),
		err: (line) => stderr.push(line),
		outText: () => stdout.join('\n'),
		errText: () => stderr.join('\n')
	};
}
