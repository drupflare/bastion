/**
 * Browser rendering, against a headless browser on the host.
 *
 * Cloudflare's binding exists because a Worker cannot fork a process, so a browser has to live
 * somewhere else and be reached over a binding. bastion already runs processes -- it supervises
 * workerd itself -- so the browser is simply another one.
 *
 * **Off unless the operator turns it on.** A headless browser is several hundred megabytes and a
 * large amount of attack surface, and no server image ships one. bastion never installs it and
 * refuses a site that binds it while `drivers.browser` is unset.
 *
 * Two surfaces, because Workers use both. The REST calls (`screenshot`, `pdf`, `content`,
 * `scrape`) are what most bundles reach for and are driven here through the browser's own
 * command line. The raw devtools endpoint is what `@cloudflare/puppeteer` connects over, and it is
 * a websocket proxy to the browser's CDP port rather than anything bastion interprets.
 *
 * A page load is arbitrary code fetching arbitrary URLs, so the browser is the one thing here that
 * must not share the tenant's egress. It runs under the tenant's own network namespace in
 * `hardened` and `isolated`, which is what keeps a site from using a screenshot call as an SSRF
 * primitive against the operator's LAN.
 */

import type { Context } from '../context';
import { BastionError } from '../errors';

export interface RenderRequest {
	url?: string;
	html?: string;
	/** css or js the caller wants applied before the capture */
	viewport?: { width: number; height: number };
	fullPage?: boolean;
	waitMs?: number;
}

export interface BrowserStore {
	id(): string;
	/** the websocket url `@cloudflare/puppeteer` connects to, or null where none is exposed */
	devtools(): Promise<string | null>;
	screenshot(request: RenderRequest): Promise<{ bytes: Uint8Array; contentType: string }>;
	pdf(request: RenderRequest): Promise<{ bytes: Uint8Array; contentType: string }>;
	content(request: RenderRequest): Promise<string>;
	isReachable(): Promise<boolean>;
}

/** a ceiling on a render, because a page that never settles would otherwise hold the process */
export const RENDER_TIMEOUT_MS = 30_000;

export interface HeadlessOptions {
	/** the browser binary; chromium and chrome take the same flags for all of this */
	command?: string;
	/** where a capture is staged before it is read back */
	scratch?: string;
	/** the browser's remote debugging endpoint, when the operator runs a long-lived one */
	devtoolsUrl?: string;
	timeoutMs?: number;
	/** hosts a render may reach; empty leaves the egress policy as the only gate */
	allow?: string[];
}

/**
 * Refuses a target that would turn a render into a request bastion did not intend.
 *
 * A screenshot call takes a URL from the worker, and the browser fetches it with the host's
 * network position rather than the caller's. `file:` reads the disk, and the loopback and
 * link-local ranges are the metadata and management surfaces a tenant must never reach. The
 * network namespace is the layer that survives a browser bug; this is the one that makes the
 * common case a clean refusal with a reason.
 */
export function assertRenderTarget(url: string, allow: string[] | undefined): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new BastionError('usage', `${url} is not a url`, { next: null });
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new BastionError('usage', `bastion renders http and https, not ${parsed.protocol}`, {
			next: null
		});
	}
	const host = parsed.hostname.toLowerCase();
	const blocked =
		host === 'localhost' ||
		host === '::1' ||
		host.endsWith('.localhost') ||
		/^127\./.test(host) ||
		/^0\./.test(host) ||
		/^10\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^169\.254\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host);
	if (blocked) {
		throw new BastionError(
			'driver-refused',
			`a render may not reach ${host}; that is the host's own network, not the tenant's`,
			{ next: 'bastion egress show' }
		);
	}
	if (allow !== undefined && allow.length > 0) {
		const ok = allow.some(
			(entry) => host === entry.toLowerCase() || host.endsWith(`.${entry.toLowerCase()}`)
		);
		if (!ok) {
			throw new BastionError('driver-refused', `renders are limited to ${allow.join(', ')}`, {
				next: 'bastion config where drivers.browser'
			});
		}
	}
}

/** the flags every capture shares; headless chromium needs its sandbox left alone under a netns */
export function chromiumArgs(options: {
	target: string;
	capture: 'screenshot' | 'pdf' | 'content';
	out: string;
	viewport?: { width: number; height: number };
	timeoutMs: number;
}): string[] {
	const args = [
		'--headless=new',
		'--disable-gpu',
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-dev-shm-usage',
		`--virtual-time-budget=${options.timeoutMs}`
	];
	if (options.viewport !== undefined) {
		args.push(`--window-size=${options.viewport.width},${options.viewport.height}`);
	}
	if (options.capture === 'screenshot') args.push(`--screenshot=${options.out}`);
	if (options.capture === 'pdf')
		args.push(`--print-to-pdf=${options.out}`, '--no-pdf-header-footer');
	if (options.capture === 'content') args.push('--dump-dom');
	args.push(options.target);
	return args;
}

export function headlessBrowser(ctx: Context, options: HeadlessOptions = {}): BrowserStore {
	const command = options.command ?? 'chromium';
	const scratch = options.scratch ?? '/tmp/bastion-browser';
	const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;

	const targetOf = (request: RenderRequest): string => {
		if (request.url !== undefined) {
			assertRenderTarget(request.url, options.allow);
			return request.url;
		}
		if (request.html !== undefined) {
			// staged as a file rather than a data: url, which chromium truncates well before a
			// real page's length and which would silently render a partial document
			const path = `${scratch}/${ctx.now()}-${Math.random().toString(36).slice(2, 10)}.html`;
			ctx.files.mkdirp(scratch);
			ctx.files.writeText(path, request.html);
			return `file://${path}`;
		}
		throw new BastionError('usage', 'a render needs a url or html', { next: null });
	};

	const capture = async (
		request: RenderRequest,
		kind: 'screenshot' | 'pdf',
		extension: string,
		contentType: string
	) => {
		const target = targetOf(request);
		const out = `${scratch}/${ctx.now()}-${Math.random().toString(36).slice(2, 10)}.${extension}`;
		ctx.files.mkdirp(scratch);
		try {
			const result = await ctx.runner.run(
				command,
				chromiumArgs({
					target,
					capture: kind,
					out,
					...(request.viewport === undefined ? {} : { viewport: request.viewport }),
					timeoutMs
				}),
				{ timeoutMs: timeoutMs + 5_000 }
			);
			if (result.code !== 0 || !ctx.files.exists(out)) {
				throw new BastionError('driver-refused', `the browser failed: ${result.stderr}`, {
					next: null
				});
			}
			return { bytes: ctx.files.readBytes(out), contentType };
		} finally {
			ctx.files.remove(out);
			if (target.startsWith('file://')) ctx.files.remove(target.slice('file://'.length));
		}
	};

	return {
		id: () => command,
		devtools: () => Promise.resolve(options.devtoolsUrl ?? null),
		isReachable: async () => {
			try {
				return (await ctx.runner.run(command, ['--version'])).code === 0;
			} catch {
				return false;
			}
		},
		screenshot: (request) => capture(request, 'screenshot', 'png', 'image/png'),
		pdf: (request) => capture(request, 'pdf', 'pdf', 'application/pdf'),
		content: async (request) => {
			const target = targetOf(request);
			try {
				const result = await ctx.runner.run(
					command,
					chromiumArgs({ target, capture: 'content', out: '', timeoutMs }),
					{ timeoutMs: timeoutMs + 5_000 }
				);
				if (result.code !== 0) {
					throw new BastionError(
						'driver-refused',
						`the browser failed: ${result.stderr}`,
						{
							next: null
						}
					);
				}
				return result.stdout;
			} finally {
				if (target.startsWith('file://')) ctx.files.remove(target.slice('file://'.length));
			}
		}
	};
}
