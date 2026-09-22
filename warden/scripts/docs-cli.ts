import { writeFileSync } from 'node:fs';
import { format } from 'prettier';
import { commandReference } from '../src/commands/lifecycle';
import { manualMarkdown } from '../src/manual';
import { IMPLEMENTED } from '../src/program';

const root = new URL('../..', import.meta.url).pathname;

/**
 * Formatted through prettier on the way out.
 *
 * CI regenerates these and fails on a diff, so a generator whose output prettier would reformat
 * makes the two checks contradict each other: the format check rewrites the file and the drift
 * check then sees a change nobody made.
 */
async function write(path: string, contents: string): Promise<void> {
	writeFileSync(path, await format(contents, { parser: 'markdown', filepath: path }));
}

await write(`${root}docs/commands.md`, commandReference(IMPLEMENTED));
await write(`${root}MANUAL.md`, manualMarkdown());
process.stdout.write('wrote docs/commands.md and MANUAL.md\n');
