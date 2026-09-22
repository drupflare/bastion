import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { headlessBrowser, type BrowserStore } from '../../src/adapters/browser';
import { memoryCacheStore } from '../../src/adapters/cache';
import { handleSlot, type AdapterSet } from '../../src/adapters/server';
import { defaultContext, type Context } from '../../src/context';
import { memoryKv } from '../../src/drivers/memory-kv';
import type { RunResult } from '../../src/host/exec';
import { containerFiles, containerRunner } from './support/container';
import { gate } from './support/gate';

/**
 * The browser adapter against a real headless chromium.
 *
 * A mock of a browser tests bastion's belief about chromium's command line, which is the half that
 * is actually in question: `--screenshot` writes a file the adapter then reads, `--dump-dom` goes
 * to stdout rather than to a file, and `--window-size` is what makes a viewport mean anything. The
 * browser is the subject here, so it is real, and it is the same argv `bastion up` would run.
 *
 * It runs in the compose stack rather than against a browser on the host, so a laptop and a CI
 * runner drive the same build. Both host seams point into that container, which is what lets the
 * adapter run unmodified: it execs `chromium-browser` and reads back the file chromium wrote.
 */
const COMPOSE = new URL('../../../docker/compose.yml', import.meta.url).pathname;
const SCRATCH = '/tmp/bastion-render';
const DEVTOOLS = 'http://127.0.0.1:19222';

/** the id compose gave the service, since the project name follows whatever directory it ran in */
function composeContainer(service: string): string {
	try {
		return execFileSync('docker', ['compose', '-f', COMPOSE, 'ps', '-q', service])
			.toString()
			.trim();
	} catch {
		return '';
	}
}

const reason = gate(['REQUIRE_DOCKER', 'BASTION_E2E_INTEGRATION']);
const container = reason === null ? composeContainer('chromium') : '';
if (reason === null && container === '') {
	throw new Error(
		'the chromium service is not up: docker compose -f docker/compose.yml up -d --wait chromium'
	);
}

const ran: string[] = [];

function context(): Context {
	const runner = containerRunner(container);
	return {
		...defaultContext(),
		files: containerFiles(container),
		runner: {
			...runner,
			run: (command: string, args: string[], options): Promise<RunResult> => {
				ran.push(command);
				return runner.run(command, args, options);
			}
		}
	};
}

const PAGE = '<!doctype html><title>bastion</title><h1 id="mark">a real render</h1>';

let browser: BrowserStore;

/** the png header carries its own dimensions, so a viewport is asserted from the image itself */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** latin1 rather than a TextDecoder: png's first byte is 0x89, which is not valid utf-8 */
const magic = (bytes: Uint8Array, length: number): string =>
	Buffer.from(bytes.slice(0, length)).toString('latin1');

describe.skipIf(reason !== null)(`the browser adapter (${reason ?? 'enabled'})`, () => {
	beforeAll(() => {
		browser = headlessBrowser(context(), {
			command: 'chromium-browser',
			scratch: SCRATCH
		});
	});

	it('reports a browser it can actually run', async () => {
		expect(await browser.isReachable()).toBe(true);
	});

	it('reports no browser when the binary is not there', async () => {
		const absent = headlessBrowser(context(), { command: 'firefox', scratch: SCRATCH });
		expect(await absent.isReachable()).toBe(false);
	});

	it('renders html to a dom the browser parsed rather than the string it was given', async () => {
		const dom = await browser.content({ html: PAGE });
		expect(dom).toContain('<h1 id="mark">a real render</h1>');
		// the browser normalises what the fixture never wrote; a passthrough would not
		expect(dom).toContain('<html>');
		expect(dom).toContain('<head>');
	});

	it('captures a png at the viewport it was asked for', async () => {
		const shot = await browser.screenshot({
			html: PAGE,
			viewport: { width: 400, height: 300 }
		});
		expect(shot.contentType).toBe('image/png');
		expect(magic(shot.bytes, 4)).toBe('\x89PNG');
		expect(pngSize(shot.bytes)).toEqual({ width: 400, height: 300 });
	});

	it('captures a different viewport, so the size came from the request', async () => {
		const shot = await browser.screenshot({
			html: PAGE,
			viewport: { width: 800, height: 600 }
		});
		expect(pngSize(shot.bytes)).toEqual({ width: 800, height: 600 });
	});

	it('prints a pdf', async () => {
		const printed = await browser.pdf({ html: PAGE });
		expect(printed.contentType).toBe('application/pdf');
		expect(magic(printed.bytes, 5)).toBe('%PDF-');
	});

	it('leaves nothing behind in the scratch directory', async () => {
		await browser.screenshot({ html: PAGE });
		await browser.content({ html: PAGE });
		const left = execFileSync('docker', ['exec', container, 'sh', '-c', `ls -A ${SCRATCH}`])
			.toString()
			.trim();
		expect(left).toBe('');
	});

	it('refuses the metadata endpoint without starting a browser at all', async () => {
		const before = ran.length;
		await expect(
			browser.screenshot({ url: 'http://169.254.169.254/latest/meta-data/' })
		).rejects.toThrow('169.254.169.254');
		expect(ran.length).toBe(before);
	});

	it('refuses a file url, which would read the host disk through a render', async () => {
		await expect(browser.content({ url: 'file:///etc/passwd' })).rejects.toThrow(
			'renders http and https'
		);
	});

	it('refuses loopback, which is where the management listener is', async () => {
		await expect(browser.screenshot({ url: 'http://127.0.0.1:8787/' })).rejects.toThrow(
			"the host's own network"
		);
	});

	it('honours an allow list against a host that is otherwise reachable', async () => {
		const limited = headlessBrowser(context(), {
			command: 'chromium-browser',
			scratch: SCRATCH,
			allow: ['example.edu']
		});
		await expect(limited.content({ url: 'https://elsewhere.test/' })).rejects.toThrow(
			'limited to example.edu'
		);
	});
});

describe.skipIf(reason !== null)(
	`the browser slot over its own http shape (${reason ?? 'ok'})`,
	() => {
		/** the other slots are present because the set requires them; nothing here reaches one */
		const adapters = (store: BrowserStore = browser): AdapterSet => ({
			cache: memoryCacheStore(),
			kv: memoryKv(),
			r2: memoryKv(),
			queues: memoryKv(),
			assets: () => Promise.resolve(null),
			browser: store
		});
		const post = (body: unknown) =>
			new Request('http://bastion/', { method: 'POST', body: JSON.stringify(body) });

		it('answers a screenshot with the image bytes and their type', async () => {
			const answer = await handleSlot(
				adapters(),
				'browser',
				post({ html: PAGE }),
				'/screenshot'
			);
			expect(answer.status).toBe(200);
			expect(answer.headers.get('content-type')).toBe('image/png');
			expect(magic(new Uint8Array(await answer.arrayBuffer()), 4)).toBe('\x89PNG');
		});

		it('answers content with the rendered dom', async () => {
			const answer = await handleSlot(
				adapters(),
				'browser',
				post({ html: PAGE }),
				'/content'
			);
			expect(answer.headers.get('content-type')).toBe('text/html');
			expect(await answer.text()).toContain('a real render');
		});

		it('turns a refused target into a 400 carrying the reason', async () => {
			const answer = await handleSlot(
				adapters(),
				'browser',
				post({ url: 'http://169.254.169.254/' }),
				'/screenshot'
			);
			expect(answer.status).toBe(400);
			expect(await answer.text()).toContain('169.254.169.254');
		});

		it('answers 501 for devtools while no endpoint is exposed', async () => {
			const answer = await handleSlot(adapters(), 'browser', post({}), '/devtools');
			expect(answer.status).toBe(501);
		});

		it('hands puppeteer a websocket url a browser is actually serving', async () => {
			const version = (await (await fetch(`${DEVTOOLS}/json/version`)).json()) as {
				Browser: string;
				webSocketDebuggerUrl: string;
			};
			expect(version.Browser).toContain('Chrome');

			const exposed = headlessBrowser(context(), {
				command: 'chromium-browser',
				scratch: SCRATCH,
				devtoolsUrl: version.webSocketDebuggerUrl
			});
			const answer = await handleSlot(adapters(exposed), 'browser', post({}), '/devtools');
			expect(answer.status).toBe(200);
			expect(
				((await answer.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl
			).toBe(version.webSocketDebuggerUrl);
		});
	}
);
