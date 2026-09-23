import { TRIPWIRES } from './tripwires';

export interface ReachabilityViolation {
	rule: string;
	subject: string;
	detail: string;
}

/**
 * The checks that answer this project's most expensive defect class.
 *
 * `defects-only-a-deploy-found.md` opens with "built, tested, and read by nobody": eleven
 * tripwires, a health ledger, a circuit breaker and a quarantine decision shipped green and wired
 * to nothing, because the state they keyed on was read by the alarm and written by no one, so two
 * rungs were unreachable by construction.
 *
 * These run as a spec rather than a lint, because a lint is something a build can be told to skip.
 */
export function checkTripwires(): ReachabilityViolation[] {
	const violations: ReachabilityViolation[] = [];
	for (const tripwire of TRIPWIRES) {
		if (tripwire.repair === null && tripwire.button.trim() === '') {
			violations.push({
				rule: 'tripwire-unreachable',
				subject: tripwire.code,
				detail: 'has neither an automatic repair nor a button, so nothing can act on it'
			});
		}
		if (tripwire.means.trim() === '') {
			violations.push({
				rule: 'tripwire-unexplained',
				subject: tripwire.code,
				detail: 'has no explanation, so `bastion diagnose` would print a code and nothing else'
			});
		}
		if (!tripwire.button.startsWith('bastion ')) {
			violations.push({
				rule: 'button-not-a-command',
				subject: tripwire.code,
				detail: `the button is ${JSON.stringify(tripwire.button)}, which is not a command to run`
			});
		}
	}
	return violations;
}

/** every config key a caller can set, as dotted paths, so an unread one is findable */
export function configKeys(config: unknown, prefix = ''): string[] {
	if (typeof config !== 'object' || config === null || Array.isArray(config)) return [];
	const out: string[] = [];
	for (const [key, value] of Object.entries(config)) {
		const path = prefix === '' ? key : `${prefix}.${key}`;
		out.push(path);
		out.push(...configKeys(value, path));
	}
	return out;
}

/**
 * Config keys nothing in the source reads.
 *
 * "Decorative configuration" is the sibling class to an unreachable tripwire: a key an operator can
 * set, that changes nothing, and that reads as a supported control until someone depends on it.
 */
export function unreadConfigKeys(
	keys: string[],
	sources: string[],
	exempt: string[] = []
): string[] {
	const haystack = sources.join('\n');
	return keys
		.map((key) => (key.includes('.') ? (key.split('.').pop() as string) : key))
		.filter((leaf, index, all) => all.indexOf(leaf) === index)
		.filter((leaf) => !exempt.includes(leaf))
		.filter((leaf) => !new RegExp(`\\b${leaf}\\b`).test(haystack));
}

/** one export the build found, and where it lives */
export interface ExportedSymbol {
	name: string;
	file: string;
}

/**
 * Every exported function a source file declares.
 *
 * Deliberately regex rather than a parser: this runs in the gate lane and a TypeScript program
 * would cost more than the rule saves. It matches the one declaration form this codebase uses.
 */
export function exportedFunctions(file: string, source: string): ExportedSymbol[] {
	return [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((match) => ({
		name: match[1] as string,
		file
	}));
}

/**
 * Guards that nothing calls.
 *
 * The class that made `isolated` a claim rather than a boundary: a refusal written, unit-tested,
 * exported and then invoked by no code path, so the property it describes simply does not hold
 * while every spec stays green. A tripwire with no repair already fails the build; so does this.
 *
 * Scoped to guard-shaped names on purpose. A plain helper with no caller is untidy, and a REFUSAL
 * with no caller is a security control an operator believes is running.
 */
export function uncalledGuards(
	declared: ExportedSymbol[],
	sources: { file: string; source: string }[],
	exempt: string[] = []
): ExportedSymbol[] {
	// `check` is in the set because `checkHeaderPolicy` was exactly this class and its name kept it
	// out. It also matches several honest non-guards, which is what the exemption list is for
	const guard = /^(assert|refuse|require|deny|forbid|check)[A-Z]/;
	return declared
		.filter((symbol) => guard.test(symbol.name) && !exempt.includes(symbol.name))
		.filter((symbol) => {
			// a guard its own module calls from an exported wrapper IS wired, so the home file
			// counts; what does not count is the declaration itself, or a barrel re-exporting it
			const uses = sources
				.filter((candidate) => !candidate.file.endsWith('index.ts'))
				.reduce((total, candidate) => {
					const body =
						candidate.file === symbol.file
							? candidate.source.replace(
									new RegExp(
										`^export (?:async )?function ${symbol.name}\\b`,
										'gm'
									),
									''
								)
							: candidate.source;
					return (
						total + (body.match(new RegExp(`\\b${symbol.name}\\b`, 'g')) ?? []).length
					);
				}, 0);
			return uses === 0;
		});
}
