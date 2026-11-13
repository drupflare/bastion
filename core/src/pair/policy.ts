import { DEFAULT_PAIRING } from '../config/defaults';
import type { BastionConfig, PairingApproval } from '../config/types';
import { COMMAND_CLASSES, type CommandClass } from './wire';

/** safe to destructive, so a higher index is the more cautious class */
export function stricter(a: CommandClass, b: CommandClass): CommandClass {
	return COMMAND_CLASSES.indexOf(a) >= COMMAND_CLASSES.indexOf(b) ? a : b;
}

/** the classes nothing may run unattended in, whatever a config object says */
const ALWAYS_QUEUED: readonly CommandClass[] = ['stateful', 'destructive'];

/**
 * What the operator chose for a class of command.
 *
 * Read from `pairing.commands`, defaulting to `queue`. The validator already refuses `auto` for a
 * stateful or destructive class; this refuses it again, because a config object built in code
 * never passed through the validator and the cost of being wrong here is a destructive command
 * running with nobody watching.
 */
export function approvalFor(config: BastionConfig, commandClass: CommandClass): PairingApproval {
	if (ALWAYS_QUEUED.includes(commandClass)) return 'queue';
	return (config.pairing ?? DEFAULT_PAIRING).commands[commandClass] ?? 'queue';
}

export type Verdict =
	| { verdict: 'refuse'; code: 'unsupported_action' }
	| { verdict: 'queue' | 'run'; effectiveClass: CommandClass };

/**
 * Decides what happens to a verified command.
 *
 * `local` is the class this box holds the action in, or null for an action it does not implement.
 * The control plane's own label can only make a command more cautious: an action this box knows to
 * be a deploy is a rebuild whatever the command calls it, so a mislabelled `safe` cannot slip past
 * an operator who set safe commands to run automatically.
 */
export function decide(
	config: BastionConfig,
	named: CommandClass,
	local: CommandClass | null
): Verdict {
	if (local === null) return { verdict: 'refuse', code: 'unsupported_action' };
	const effectiveClass = stricter(named, local);
	return {
		verdict: approvalFor(config, effectiveClass) === 'auto' ? 'run' : 'queue',
		effectiveClass
	};
}
