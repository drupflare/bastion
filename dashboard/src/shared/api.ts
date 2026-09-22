export interface ApiEnvelope<T> {
	ok: boolean;
	result?: T;
	error?: { code: string; message: string; retryable: boolean; next: string | null };
}

export const CSRF_HEADER = 'x-bastion-csrf';

export class ApiError extends Error {
	readonly code: string;
	readonly next: string | null;
	readonly status: number;

	constructor(status: number, code: string, message: string, next: string | null) {
		super(message);
		this.status = status;
		this.code = code;
		this.next = next;
	}
}

/**
 * Every call the dashboard makes.
 *
 * The CSRF token rides a header rather than a cookie, because the check on the other side is a
 * synchronizer token bound to the session. `SameSite` on the session cookie is defence in depth
 * and does not replace it.
 */
export async function call<T>(
	path: string,
	options: { method?: string; body?: unknown; csrf?: string; base?: string } = {}
): Promise<T> {
	const method = options.method ?? 'GET';
	const headers: Record<string, string> = { accept: 'application/json' };
	if (options.body !== undefined) headers['content-type'] = 'application/json';
	if (options.csrf !== undefined && method !== 'GET') headers[CSRF_HEADER] = options.csrf;

	const response = await fetch(`${options.base ?? ''}${path}`, {
		method,
		headers,
		credentials: 'same-origin',
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
	});

	const envelope = (await response.json().catch(() => ({ ok: false }))) as ApiEnvelope<T>;
	if (!response.ok || envelope.ok !== true) {
		throw new ApiError(
			response.status,
			envelope.error?.code ?? 'unknown',
			envelope.error?.message ?? `the request failed with ${response.status}`,
			envelope.error?.next ?? null
		);
	}
	return envelope.result as T;
}

export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface HealthNode {
	name: string;
	severity: Severity;
	detail: string;
	children: HealthNode[];
}

export interface TenantSummary {
	name: string;
	sites: { host: string; primary?: string; replicas?: string[] }[];
	limits?: { cpu?: string; memory?: number; pids?: number; maxSites?: number };
	egress?: { allow: string[] };
}

export interface CapacityAnswer {
	known: boolean;
	recommended: number;
	maximum: number;
	bindingTerm: string;
	provenance: 'probed' | 'stated' | 'assumed';
	concurrencyCeiling: number | null;
	terms: { name: string; value: number; unit: string; provenance: string; source: string }[];
	notes: string[];
}

/** the word a severity is announced by; the colour comes from the badge that carries it */
export const SEVERITY_LABEL: Record<Severity, string> = {
	debug: 'Debug',
	info: 'Healthy',
	warn: 'Warning',
	error: 'Error',
	critical: 'Critical'
};
