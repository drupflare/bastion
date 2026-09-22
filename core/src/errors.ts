/**
 * Exit codes bastion uses, as a closed set.
 *
 * `FINDING` exists so a script can tell "the check could not run" from "the check ran and the
 * answer is no". Collapsing those two onto 1 is what makes a CI step grep output instead of
 * reading a status.
 */
export const EXIT = {
	OK: 0,
	FAILED: 1,
	USAGE: 2,
	FINDING: 3
} as const;

/** what a caller passes when it raises one of these */
export interface ErrorFacts {
	exitCode?: number;
	/** whether re-running the same command could succeed with nothing else changing */
	retryable?: boolean;
	/** the command to run next, or null when there is not one */
	next?: string | null;
}

/**
 * Base for every error bastion raises on purpose; anything else is a bug and becomes `internal`.
 *
 * **`retryable` is about the OPERATION, not about the network.** A node that is still joining is
 * retryable because the same request succeeds once it has; a refused capability is not, even
 * though it may also stop happening. Nothing here loops on the flag; it exists so a wrapper does
 * not have to pattern-match a message.
 *
 * **`next` is a COMMAND, never advice.** `bastion cluster join --control ...` is a next step;
 * "check your configuration" is not, and is left out rather than padded.
 */
export class BastionError extends Error {
	readonly code: string;
	readonly exitCode: number;
	readonly retryable: boolean;
	readonly next: string | null;

	constructor(code: string, message: string, facts: ErrorFacts | number = {}) {
		super(message);
		const settled = typeof facts === 'number' ? { exitCode: facts } : facts;
		this.name = new.target.name;
		this.code = code;
		this.exitCode = settled.exitCode ?? CODES[code]?.exit ?? EXIT.FAILED;
		this.retryable = settled.retryable ?? CODES[code]?.retryable ?? false;
		this.next = settled.next ?? CODES[code]?.next ?? null;
	}

	/** the object `--json` prints on the failure path, so stdout parses either way */
	toJSON(): { ok: false; error: Record<string, unknown> } {
		return {
			ok: false,
			error: {
				code: this.code,
				message: this.message,
				retryable: this.retryable,
				next: this.next
			}
		};
	}
}

/** bad input from the caller */
export class UsageError extends BastionError {
	constructor(message: string, next?: string | null) {
		super('usage', message, { exitCode: EXIT.USAGE, retryable: false, next: next ?? null });
	}
}

/** the check ran and found something the operator has to act on */
export class FindingError extends BastionError {
	constructor(code: string, message: string, facts: ErrorFacts = {}) {
		super(code, message, { exitCode: EXIT.FINDING, ...facts });
	}
}

/**
 * Every code bastion raises, with its exit, whether a retry could work, and what to run next.
 *
 * One table rather than a field on each `throw`, so two call sites cannot disagree about what
 * `capability-refused` means. A `throw` may still override any of the three where the answer is
 * specific to the call.
 */
export const CODES: Record<string, { exit: number; retryable: boolean; next: string | null }> = {
	usage: { exit: EXIT.USAGE, retryable: false, next: null },
	internal: { exit: EXIT.FAILED, retryable: false, next: null },

	// config
	'config-missing': { exit: EXIT.USAGE, retryable: false, next: 'bastion init' },
	'config-invalid': { exit: EXIT.USAGE, retryable: false, next: 'bastion config validate' },
	'config-unwritable': { exit: EXIT.FAILED, retryable: false, next: null },

	// runtime
	'workerd-missing': { exit: EXIT.FAILED, retryable: true, next: 'bastion update apply' },
	'workerd-digest': { exit: EXIT.FAILED, retryable: false, next: 'bastion update apply' },
	'workerd-boot': { exit: EXIT.FAILED, retryable: true, next: 'bastion logs --tenant' },
	'below-floor': { exit: EXIT.USAGE, retryable: false, next: null },
	'storage-format': { exit: EXIT.USAGE, retryable: false, next: 'bastion backup now' },

	// isolation and the host
	'preflight-unsupported': { exit: EXIT.FINDING, retryable: false, next: 'bastion doctor' },
	'multi-tenant-unsafe': { exit: EXIT.USAGE, retryable: false, next: null },
	'capability-refused': { exit: EXIT.USAGE, retryable: false, next: null },
	'permission-denied': { exit: EXIT.FAILED, retryable: false, next: null },

	// capacity and placement
	'capacity-exceeded': { exit: EXIT.USAGE, retryable: false, next: 'bastion capacity' },

	// adapters
	'driver-unreachable': { exit: EXIT.FAILED, retryable: true, next: 'bastion doctor' },
	'driver-refused': { exit: EXIT.FAILED, retryable: false, next: null },

	// health
	'health-finding': { exit: EXIT.FINDING, retryable: false, next: 'bastion diagnose' },
	quarantined: { exit: EXIT.FINDING, retryable: false, next: 'bastion quarantine clear' }
};
