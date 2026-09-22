/**
 * The HTTP shapes workerd speaks to a bound service.
 *
 * These are measured from the 2026-09-21 smoke lane rather than inferred: `nullcache.js` and
 * `kvstub.js` in `tests/fixtures/smoke/` are the stubs workerd actually accepted. Getting one
 * wrong does not fail loudly -- a cache that answers the wrong status for a miss simply never
 * caches, which reads as a performance problem rather than a protocol bug.
 */

/** cache: a miss answers 504, a store answers 204, a purge of an absent key answers 404 */
export const CACHE_STATUS = {
	miss: 504,
	stored: 204,
	purgedAbsent: 404,
	methodNotAllowed: 405
} as const;

/** kv: the key is the decoded pathname with its leading slash removed */
export function keyFromPath(pathname: string): string {
	return decodeURIComponent(pathname.replace(/^\//, ''));
}

export function pathFromKey(key: string): string {
	return `/${encodeURIComponent(key)}`;
}

/** kv and r2 both answer 404 for an absent key and 204 for a write */
export const STORE_STATUS = {
	absent: 404,
	written: 204,
	deleted: 204,
	methodNotAllowed: 405
} as const;
