/**
 * Whether a lane runs, and why it does not.
 *
 * `REQUIRE_X=1` is an instruction rather than a preference. Once it is set the lane must run, so a
 * missing prerequisite throws here instead of returning a skip reason. Answering one with a skip
 * is how a lane reports green without executing: CI set `REQUIRE_DOCKER=1` and never
 * `REQUIRE_PAYLOAD=1`, so the lane that proves the released payload boots printed a skip line and
 * passed for weeks.
 */

/** something the lane needs before it can run, named the way the failure should read */
export interface Prerequisite {
	/** the clause after `REQUIRE_X=1 but`, e.g. `WORKERD_BINARY (/nope) is not a file` */
	what: string;
	present: boolean;
}

export function gate(
	keys: string | readonly string[],
	needs: readonly Prerequisite[] = [],
	env: NodeJS.ProcessEnv = process.env
): string | null {
	const all = typeof keys === 'string' ? [keys] : keys;
	const set = all.filter((key) => env[key] === '1');
	if (set.length === 0) return `${all.map((key) => `${key}=1`).join(' or ')} is not set`;
	for (const need of needs) {
		if (!need.present) throw new Error(`${set[0] as string}=1 but ${need.what}`);
	}
	return null;
}
