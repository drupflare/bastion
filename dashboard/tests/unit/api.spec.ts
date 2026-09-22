import { describe, expect, it, vi } from 'vitest';
import { useSession } from '../../src/composables/useSession';
import { ApiError, CSRF_HEADER, SEVERITY_LABEL, call } from '../../src/shared/api';

function stubFetch(status: number, body: unknown): Request[] {
	const seen: Request[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		seen.push(new Request(`http://local${url}`, init));
		return new Response(JSON.stringify(body), { status });
	});
	return seen;
}

describe('call', () => {
	it('unwraps the envelope on success', async () => {
		stubFetch(200, { ok: true, result: { up: true } });
		expect(await call('/api/status')).toEqual({ up: true });
	});

	it('raises a typed error carrying the code and the next command', async () => {
		stubFetch(403, {
			ok: false,
			error: {
				code: 'capability-refused',
				message: 'nope',
				retryable: false,
				next: 'bastion doctor'
			}
		});
		await expect(call('/api/status')).rejects.toThrow(ApiError);
		await expect(call('/api/status')).rejects.toMatchObject({
			code: 'capability-refused',
			next: 'bastion doctor'
		});
	});

	it('raises when the transport succeeded but the envelope says it did not', async () => {
		stubFetch(200, {
			ok: false,
			error: { code: 'csrf', message: 'no token', retryable: false, next: null }
		});
		await expect(call('/api/status')).rejects.toMatchObject({ code: 'csrf' });
	});

	it('sends the CSRF token on a write and not on a read', async () => {
		const seen = stubFetch(200, { ok: true, result: {} });
		await call('/api/tenants', { method: 'POST', body: { name: 'a' }, csrf: 'TOKEN' });
		await call('/api/tenants', { csrf: 'TOKEN' });
		expect(seen[0]?.headers.get(CSRF_HEADER)).toBe('TOKEN');
		expect(seen[1]?.headers.get(CSRF_HEADER)).toBe(null);
	});

	it('sends the session cookie same-origin only', async () => {
		const seen = stubFetch(200, { ok: true, result: {} });
		await call('/api/status');
		expect(seen[0]?.credentials).toBe('same-origin');
	});
});

describe('severity presentation', () => {
	// a severity conveyed only by colour fails 1.4.1, so every level has a word of its own
	it('names every severity in words, and no two the same', () => {
		const levels = ['debug', 'info', 'warn', 'error', 'critical'] as const;
		const labels = levels.map((level) => SEVERITY_LABEL[level]);
		for (const label of labels) expect(label.length).toBeGreaterThan(3);
		expect(new Set(labels).size).toBe(levels.length);
	});
});

describe('useSession', () => {
	it('shows an operator every tenant', async () => {
		stubFetch(200, {
			ok: true,
			result: [
				{ name: 'a', sites: [] },
				{ name: 'b', sites: [] }
			]
		});
		const session = useSession();
		session.adopt({ id: 'op', role: 'operator', tenant: null }, 'T');
		await session.load();
		expect(session.visibleTenants.value.map((t) => t.name)).toEqual(['a', 'b']);
		expect(session.isOperator.value).toBe(true);
	});

	it('filters a tenant credential down to its own tenant', async () => {
		stubFetch(200, {
			ok: true,
			result: [
				{ name: 'a', sites: [] },
				{ name: 'b', sites: [] }
			]
		});
		const session = useSession();
		session.adopt({ id: 'u', role: 'tenant-admin', tenant: 'b' }, 'T');
		await session.load();
		expect(session.visibleTenants.value.map((t) => t.name)).toEqual(['b']);
		expect(session.isOperator.value).toBe(false);
		expect(session.canWrite.value).toBe(true);
	});

	it('gives a viewer no write surface', async () => {
		stubFetch(200, { ok: true, result: [] });
		const session = useSession();
		session.adopt({ id: 'v', role: 'tenant-viewer', tenant: 'b' }, 'T');
		expect(session.canWrite.value).toBe(false);
	});

	it('shows nothing before anyone has signed in', () => {
		const session = useSession();
		session.principal.value = null;
		expect(session.visibleTenants.value).toEqual([]);
	});
});

/**
 * Signing in, which is the only way a browser gets a credential.
 *
 * The console rendered a signed-out shell forever before this existed: `GET /api/session` answered
 * 401, and nothing anywhere exchanged the claim token the CLI prints for a session.
 */
describe('signIn', () => {
	it('posts the claim and adopts the principal it comes back with', async () => {
		const seen = stubFetch(200, {
			ok: true,
			result: { id: 'operator', role: 'operator', tenant: null, csrf: 'csrf-token' }
		});
		const session = useSession();
		await session.signIn('a-claim').catch(() => undefined);

		const posted = seen.find((request) => request.method === 'POST');
		expect(posted?.url).toContain('/api/session');
		expect(await posted?.json()).toEqual({ claim: 'a-claim' });
		expect(session.principal.value?.role).toBe('operator');
		expect(session.csrf.value).toBe('csrf-token');
	});

	it('leaves the console signed out when the claim is refused', async () => {
		stubFetch(401, {
			ok: false,
			error: { code: 'unauthenticated', message: 'that claim is not valid', retryable: false }
		});
		const session = useSession();
		session.principal.value = null;
		await expect(session.signIn('wrong')).rejects.toThrow('that claim is not valid');
		expect(session.principal.value).toBe(null);
	});

	it('sends the csrf header when signing out, which the server checks', async () => {
		const seen = stubFetch(200, { ok: true, result: { signedOut: true } });
		const session = useSession();
		session.adopt({ id: 'operator', role: 'operator', tenant: null }, 'csrf-token');
		await session.signOut();

		const sent = seen.find((request) => request.method === 'DELETE');
		expect(sent?.headers.get(CSRF_HEADER)).toBe('csrf-token');
		expect(session.principal.value).toBe(null);
		expect(session.csrf.value).toBe('');
	});
});
