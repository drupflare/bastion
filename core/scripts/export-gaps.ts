import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Adds the public types typedoc reports as reachable-but-unexported to `core/src/index.ts`.
 *
 * Every one is a type a caller has to name in order to use an exported function: an options bag, a
 * result, a union a field is typed with. Leaving them out renders them as bare unlinked words in
 * the API docs and makes them unimportable, so the fix is mechanical and belongs in a script rather
 * than in eighty-seven hand edits.
 *
 * Run from the repository root: `bun core/scripts/export-gaps.ts`
 */
const INDEX = new URL('../src/index.ts', import.meta.url).pathname;

// typedoc writes its warnings to stderr, so they are merged rather than dropped
const warnings = execSync('bunx typedoc 2>&1', {
	cwd: new URL('../..', import.meta.url).pathname,
	encoding: 'utf8',
	maxBuffer: 32 * 1024 * 1024
});

const missing = new Map<string, Set<string>>();
for (const line of warnings.split('\n')) {
	const match =
		/(\w+), defined in @drupflare\/bastion\/src\/(.+?)\.ts, is referenced by .+ but not included/.exec(
			line
		);
	if (match === null) continue;
	const [, name, file] = match as unknown as [string, string, string];
	if (!missing.has(file)) missing.set(file, new Set());
	missing.get(file)?.add(name);
}

let source = readFileSync(INDEX, 'utf8');
const added: string[] = [];
const appended: string[] = [];

for (const [file, names] of [...missing].sort()) {
	const from = `'./${file}'`;
	// the existing block for this module, so the addition lands beside its siblings
	const block = new RegExp(`export \\{([^}]*)\\} from ${from.replace(/[.*+?^$]/g, '\\$&')};`);
	const found = block.exec(source);
	const wanted = [...names].filter((name) => {
		const already = found?.[1] ?? '';
		return !new RegExp(`\\b${name}\\b`).test(already);
	});
	if (wanted.length === 0) continue;

	if (found === null) {
		appended.push(`export { ${wanted.map((n) => `type ${n}`).join(', ')} } from ${from};`);
		added.push(...wanted.map((n) => `${n} (new line)`));
		continue;
	}
	const inner = (found[1] as string).trimEnd().replace(/,\s*$/, '');
	source = source.replace(
		found[0],
		`export {${inner},\n\t${wanted.map((n) => `type ${n}`).join(',\n\t')}\n} from ${from};`
	);
	added.push(...wanted);
}

if (appended.length > 0) source = `${source.trimEnd()}\n${appended.join('\n')}\n`;
writeFileSync(INDEX, source);
process.stdout.write(`added ${added.length} exports across ${missing.size} modules\n`);
