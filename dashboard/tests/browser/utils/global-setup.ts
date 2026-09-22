import { request } from '@playwright/test';

/**
 * Proves the rig is answering before any spec runs.
 *
 * Playwright's `webServer.url` poll accepts any status, so a rig that started and then answered
 * 503 because the SPA was never built would present as fifteen unrelated spec failures rather
 * than as one message naming the build.
 */
export default async function globalSetup(): Promise<void> {
	const base = process.env.BASTION_BROWSER_URL ?? 'https://127.0.0.1:8788';
	const api = await request.newContext({ baseURL: base, ignoreHTTPSErrors: true });
	try {
		const page = await api.get('/');
		if (!page.ok()) {
			throw new Error(
				`the rig answered ${page.status()} for /; run \`bunx nuxi generate\` in dashboard/`
			);
		}
		const session = await api.get('/rig/session');
		if (!session.ok()) throw new Error(`the rig could not mint a session: ${session.status()}`);
	} finally {
		await api.dispose();
	}
}
