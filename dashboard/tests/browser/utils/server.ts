import {
	SessionStore,
	TokenStore,
	defaultConfig,
	defaultContext,
	handleApi,
	hashPassword,
	memoryFiles,
	selfSigned,
	sessionCookie,
	type Account,
	type ApiHandler
} from '@drupflare/bastion';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { FIXTURES } from './fixtures';

const PORT = Number(process.env.BASTION_BROWSER_PORT ?? 8788);
const ROOT = new URL('../../../dist/', import.meta.url).pathname;

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2'
};

/**
 * The dashboard served the way bastion serves it.
 *
 * Over TLS rather than plain HTTP, because the shipped session cookie carries `__Host-` and
 * `Secure` and HSTS only appears on the secure listener. A rig on `http://` would exercise a
 * cookie posture bastion does not ship, which is the same class of error as measuring with a
 * feature switched off.
 *
 * `/api/*` goes through the real `handleApi`, so the browser meets the real authorization, the
 * real CSRF check and the real security headers. Only the handlers behind the route table are
 * fixtures; everything in front of them is the shipped code.
 */
const ctx = { ...defaultContext(), files: memoryFiles(), now: () => Date.now() };
const config = defaultConfig();
const sessions = new SessionStore(ctx);
const tokens = new TokenStore(ctx);

// the shipped cost is ~32 MiB per attempt, which a rig pays on every start for no signal
const RIG_COST = { N: 1024, r: 8, p: 1 };

const ACCOUNTS: Record<string, Account> = {
	operator: {
		id: 'ops',
		role: 'operator',
		tenant: null,
		password: hashPassword('rig-password', undefined, RIG_COST)
	},
	'tenant-admin': {
		id: 'acme-admin',
		role: 'tenant-admin',
		tenant: 'acme',
		password: hashPassword('rig-password', undefined, RIG_COST)
	}
};

const handlers: Record<string, ApiHandler> = Object.fromEntries(
	Object.entries(FIXTURES).map(([key, value]) => [key, () => value])
);

function staticFile(pathname: string): Response | null {
	const relative = normalize(pathname === '/' ? '/index.html' : pathname).replace(
		/^(\.\.[/])+/,
		''
	);
	const candidates = [join(ROOT, relative), join(ROOT, relative, 'index.html')];
	for (const candidate of candidates) {
		if (!candidate.startsWith(ROOT)) continue;
		try {
			if (!statSync(candidate).isFile()) continue;
		} catch {
			continue;
		}
		return new Response(readFileSync(candidate), {
			headers: { 'content-type': TYPES[extname(candidate)] ?? 'application/octet-stream' }
		});
	}
	return null;
}

const cert = selfSigned(['localhost', '127.0.0.1']);

Bun.serve({
	port: PORT,
	tls: { key: cert.privateKeyPem, cert: cert.certificatePem },
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// the rig's only extra route: mints a real session so a spec starts signed in without
		// driving a login form that does not exist yet
		if (url.pathname === '/rig/session') {
			const role = url.searchParams.get('role') ?? 'operator';
			const account = ACCOUNTS[role];
			if (account === undefined) return new Response('unknown role', { status: 400 });
			const session = sessions.login(account, 'rig-password');
			return new Response(JSON.stringify({ csrf: session.csrfToken, role }), {
				headers: {
					'content-type': 'application/json',
					'set-cookie': sessionCookie(session.id, 3600)
				}
			});
		}

		if (url.pathname.startsWith('/api/')) {
			return handleApi(ctx, request, {
				config,
				sessions,
				tokens,
				origin: url.origin,
				handlers
			});
		}

		// a built SPA answers its own routes from index.html; a missing asset stays a 404
		return (
			staticFile(url.pathname) ??
			(extname(url.pathname) === ''
				? (staticFile('/index.html') ?? new Response('not built', { status: 503 }))
				: new Response('not found', { status: 404 }))
		);
	}
});

process.stdout.write(`dashboard rig on https://127.0.0.1:${PORT}\n`);
