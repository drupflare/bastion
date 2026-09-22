/**
 * What a driver's endpoint can do.
 *
 * Probed once per endpoint and cached. **A probe that cannot run returns conservative defaults
 * rather than optimistic ones**, so an unknown endpoint degrades to more requests instead of to
 * failed ones. The engine branches on the answer, never on a driver name.
 */
export interface Capabilities {
	/** the endpoint honours a write conditional on the key being absent */
	conditionalWrite: boolean;
	/** ranged reads */
	byteRange: boolean;
	/** many keys removed in one request */
	batchDelete: boolean;
	/** listing returns a continuation token rather than everything at once */
	pagedList: boolean;
	/** per-key expiry the endpoint enforces itself */
	ttl: boolean;
	/** the largest single value the endpoint accepts, or null when it is not known */
	maxValueBytes: number | null;
}

/** what an endpoint that could not be probed is assumed to do: as little as possible */
export const CONSERVATIVE: Capabilities = {
	conditionalWrite: false,
	byteRange: false,
	batchDelete: false,
	pagedList: false,
	ttl: false,
	maxValueBytes: null
};

export function capabilities(overrides: Partial<Capabilities> = {}): Capabilities {
	return { ...CONSERVATIVE, ...overrides };
}

/** every driver answers these, whatever it stores */
export interface Driver {
	/** a short lowercase token such as "sqlite", "redis", "fs", "s3" */
	id(): string;
	/** the label a settings form shows */
	label(): string;
	/** probed once and cached; conservative when the probe cannot run */
	capabilities(): Capabilities;
	/** cheap, and must not throw: `doctor` and a settings form both call it */
	isReachable(): Promise<boolean>;
	/** why it is unreachable, or null */
	unreachableReason(): string | null;
}
