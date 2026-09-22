import type { Context } from '@drupflare/bastion';
import { BastionError, EXIT, UsageError } from '@drupflare/bastion';
import { buildProgram } from './program';

/**
 * Runs the CLI and maps anything thrown onto the closed exit set.
 *
 * **No stack traces.** Anything that is not a `BastionError` is a bug here, so it becomes
 * `internal` with its message and a pointer at `--verbose`. Under `--json`, stdout carries the
 * error object on the failure path too, so a caller parsing stdout does not have to branch on the
 * exit code before it can read what happened.
 */
export async function run(ctx: Context, argv: string[]): Promise<number> {
	const json = argv.includes('--json');
	const verbose = argv.includes('--verbose');
	const outcome = { code: EXIT.OK };
	try {
		const program = buildProgram(ctx, outcome);
		await program.parseAsync(argv, { from: 'user' });
		return outcome.code;
	} catch (e) {
		if (e instanceof BastionError) {
			if (json) ctx.io.out(JSON.stringify(e.toJSON()));
			else {
				ctx.io.err(e.message);
				if (e.next !== null) ctx.io.err(`next: ${e.next}`);
			}
			if (verbose && e.stack !== undefined) ctx.io.err(e.stack);
			return e.exitCode;
		}
		// commander raises its own class for bad input; those are usage errors, not internal ones,
		// and collapsing them onto 1 makes a typo indistinguishable from a crash
		const commanderCode = (e as { code?: string }).code;
		if (typeof commanderCode === 'string' && commanderCode.startsWith('commander.')) {
			const usage = new UsageError((e as Error).message.replace(/^error: /, ''));
			if (json) ctx.io.out(JSON.stringify(usage.toJSON()));
			else ctx.io.err(usage.message);
			return usage.exitCode;
		}
		const message = e instanceof Error ? e.message : String(e);
		const wrapped = new BastionError('internal', message);
		if (json) ctx.io.out(JSON.stringify(wrapped.toJSON()));
		else ctx.io.err(`internal: ${message}`);
		if (verbose && e instanceof Error && e.stack !== undefined) ctx.io.err(e.stack);
		else if (!verbose) ctx.io.err('re-run with --verbose for the stack');
		return EXIT.FAILED;
	}
}
