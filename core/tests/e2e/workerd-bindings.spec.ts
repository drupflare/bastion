import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryCacheStore } from '../../src/adapters/cache';
import { recordingEmail } from '../../src/adapters/email';
import { readHeader, type ImageInfo } from '../../src/adapters/images';
import { ADAPTER_SLOTS, handleSlot, type AdapterSet } from '../../src/adapters/server';
import { memoryVectors } from '../../src/adapters/vectors';
import { renderConfig } from '../../src/capnp/generate';
import { planSite, socketFor } from '../../src/capnp/plan';
import { memoryKv } from '../../src/drivers/memory-kv';
import { buildSql } from '../../src/drivers/registry';
import { DataPointWindow } from '../../src/observe/analytics';
import { gate } from './support/gate';

/**
 * A real workerd, booted from a configuration bastion generated, serving a worker bastion did not
 * write.
 *
 * This is the lane the whole project rests on and it needs NO drupflare payload: the worker below
 * is eight lines written here, which is the point. It proves three separate things that were
 * otherwise only ever asserted against generated text:
 *
 *   1. the generated `config.capnp` parses and boots at all
 *   2. a worker with no Durable Object and no assets runs, which the generator emitted
 *      unconditionally until recently and could not have
 *   3. `wrapped` bindings work -- `env.DB.prepare()` reaches bastion's sql adapter over the unix
 *      socket and comes back with rows. D1, Vectorize, Workers AI, Images, Browser, send_email and
 *      Analytics Engine all ride that one mechanism, so this boots the shape all seven depend on
 *
 * Every earlier test of the shims was a string assertion on the capnp text. A string assertion
 * cannot tell you whether workerd accepts the extension block, and if it does not then all seven
 * bindings fail together.
 *
 * sqlite backs the D1 side deliberately: it is compiled in, so this lane needs no compose stack
 * and can run on any runner that can download workerd.
 */
const workerd = process.env.WORKERD_BINARY ?? 'workerd';

/**
 * Skips only when nobody asked for this lane; refuses when they did and it cannot run.
 *
 * `REQUIRE_WORKERD=1` means this MUST run. A lane that answers a missing prerequisite by skipping
 * reports success, which is how the workerd boot went unexercised for the whole of development:
 * CI set `REQUIRE_DOCKER=1` and never `REQUIRE_PAYLOAD=1`, so the one lane that proved the
 * generated configuration works printed a skip reason and went green every time.
 */
const reason = gate('REQUIRE_WORKERD', [
	{
		what: `WORKERD_BINARY (${workerd}) is not a file`,
		present: !workerd.includes('/') || existsSync(workerd)
	}
]);
const children: { kill(signal?: NodeJS.Signals): void }[] = [];
const servers: { stop(force?: boolean): void }[] = [];
const adapterFailures: string[] = [];

/**
 * Speaks HTTP to workerd over its unix socket, which is how bastion itself reaches it.
 *
 * A TCP listener would be the easier rig and it would be testing a shape bastion never generates:
 * `planSite` always emits `unix:` on the tenant's listen socket, because the front door terminates
 * TLS and proxies inward. Testing over TCP here would have hidden that.
 */
function overSocket(
	socketPath: string,
	path: string
): Promise<{
	status: number;
	body: string;
	headers: Record<string, string | string[] | undefined>;
}> {
	return new Promise((resolve, reject) => {
		const req = request(
			{ socketPath, path, method: 'GET', headers: { host: '127.0.0.1' } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString(),
						headers: res.headers
					})
				);
			}
		);
		req.on('error', reject);
		req.end();
	});
}

/**
 * The whole worker under test: one route per binding, and nothing else.
 *
 * Every wrapped binding rides the same mechanism, so booting one proves the mechanism and booting
 * all seven proves each shim's own contract against the adapter on the other side of the socket.
 * That is where the D1 shim's `{rows}` against `{results}` mismatch was hiding, and each of the
 * others has its own translation to get wrong.
 */
const WORKER = `
const PNG = [
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
	0, 0, 0, 4, 0, 0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0
];

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/health') {
			return new Response('ok', { headers: { 'x-from': 'worker' } });
		}
		if (url.pathname === '/rows') {
			await env.DB.prepare('create table if not exists t (id integer, name text)').run();
			await env.DB.prepare('insert into t (id, name) values (?, ?)').bind(1, 'acme').run();
			const found = await env.DB.prepare('select name from t where id = ?').bind(1).all();
			return Response.json({ rows: found.results });
		}
		if (url.pathname === '/first') {
			const name = await env.DB.prepare('select name from t where id = ?').bind(1).first('name');
			return new Response(String(name));
		}
		if (url.pathname === '/kv') {
			await env.SESSIONS.put('k', 'v');
			return new Response((await env.SESSIONS.get('k')) ?? 'absent');
		}
		if (url.pathname === '/batch') {
			const answers = await env.DB.batch([
				env.DB.prepare('select 1 as a'),
				env.DB.prepare('select 2 as a')
			]);
			return Response.json({ count: answers.length, first: answers[0].results });
		}
		if (url.pathname === '/vector') {
			await env.INDEX.upsert([{ id: 'a', values: [1, 0] }, { id: 'b', values: [0, 1] }]);
			const near = await env.INDEX.query([1, 0], { topK: 1 });
			return Response.json({ id: near.matches[0].id, described: await env.INDEX.describe() });
		}
		if (url.pathname === '/ai') {
			return Response.json(await env.AI.run('stub-model', { prompt: 'hello' }));
		}
		if (url.pathname === '/mail') {
			await env.MAILER.send({
				from: 'noreply@example.edu',
				to: 'ops@example.edu',
				raw: 'Subject: hi\\r\\n\\r\\nbody'
			});
			return new Response('sent');
		}
		if (url.pathname === '/metric') {
			env.AE.writeDataPoint({ indexes: ['acme'], doubles: [1.5], blobs: ['ok'] });
			return new Response('recorded');
		}
		if (url.pathname === '/image') {
			const info = await env.IMAGES.info(new Uint8Array(PNG));
			return Response.json(info);
		}
		return new Response('not found', { status: 404 });
	}
};
`;

afterAll(() => {
	for (const child of children) child.kill('SIGTERM');
	for (const server of servers) server.stop(true);
});

describe.skipIf(reason !== null)(`workerd bindings (${reason ?? 'enabled'})`, () => {
	const root = mkdtempSync(join(tmpdir(), 'bastion-bindings-'));
	const listen = join(root, 'http.sock');
	const mail = recordingEmail();
	const metrics = new DataPointWindow();
	let stderr = '';

	beforeAll(async () => {
		writeFileSync(join(root, 'index.js'), WORKER);

		// bastion's own adapters, each backed by something that needs no external service: sqlite
		// is compiled in, the vector index and the analytics ring are in process, and mail is
		// recorded rather than sent. The inference and image stores are the two that would reach a
		// real endpoint, so they are stubbed here and covered against real ones in their own lanes
		const sql = buildSql({ driver: 'sqlite', path: join(root, 'd1.sqlite') });
		const adapters: AdapterSet = {
			cache: memoryCacheStore(),
			kv: memoryKv(),
			r2: memoryKv(),
			queues: memoryKv(),
			assets: () => Promise.resolve(null),
			sql,
			vectorize: memoryVectors({ dimensions: 2 }),
			email: mail,
			analytics: metrics,
			tenant: 'acme',
			ai: {
				id: () => 'stub',
				models: () => Promise.resolve(['stub-model']),
				isReachable: () => Promise.resolve(true),
				run: (r) => Promise.resolve({ result: { echoed: r.model } })
			},
			images: {
				id: () => 'stub',
				isReachable: () => Promise.resolve(true),
				info: (bytes) => Promise.resolve(readHeader(bytes) as ImageInfo),
				transform: (bytes) => Promise.resolve({ bytes, contentType: 'image/png' })
			}
		};
		// One listener per slot, on the paths `socketFor` derives, which is what bastion itself
		// binds. node rather than Bun.serve: vitest runs this file under node, so the bun global
		// is absent. Only the method, the url and a couple of headers carry over; forwarding
		// node's own bag hands `content-length` to a Request that recomputes it.
		for (const slot of ADAPTER_SLOTS) {
			const server = createServer((req, res) => {
				const chunks: Buffer[] = [];
				req.on('data', (chunk: Buffer) => chunks.push(chunk));
				req.on('end', () => {
					const body = Buffer.concat(chunks);
					const headers: Record<string, string> = {};
					for (const [name, value] of Object.entries(req.headers)) {
						// every header bastion's own adapters read, and nothing node computes:
						// forwarding `content-length` hands a Request a length it recalculates
						if (typeof value !== 'string') continue;
						if (name === 'content-type' || name.startsWith('x-bastion-')) {
							headers[name] = value;
						}
					}
					const url = new URL(`http://bastion${req.url ?? '/'}`);
					const request = new Request(url, {
						method: req.method,
						headers,
						...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body })
					});
					void handleSlot(adapters, slot, request, url.pathname)
						.then(async (answer) => {
							res.writeHead(answer.status, Object.fromEntries(answer.headers));
							res.end(Buffer.from(await answer.arrayBuffer()));
						})
						.catch((error: unknown) => {
							// surfaced rather than swallowed: a 500 carrying no reason is what made
							// the first run of this lane take three guesses to diagnose
							adapterFailures.push(`${slot}: ${String(error)}`);
							res.writeHead(500);
							res.end(String(error));
						});
				});
			});
			await new Promise<void>((resolve) =>
				server.listen(socketFor({ adapterDir: root }, slot), resolve)
			);
			servers.push({ stop: () => server.close() });
		}

		const config = planSite({
			tenant: { name: 'acme', sites: [] },
			site: { host: '127.0.0.1', bundle: root },
			paths: {
				bundle: root,
				storage: join(root, 'storage'),
				assets: join(root, 'assets'),
				adapterDir: root,
				listenSocket: listen
			},
			modules: [{ name: 'index.js', kind: 'esModule', embed: 'index.js' }],
			compatibilityDate: '2026-08-01',
			compatibilityFlags: ['nodejs_compat'],
			uniqueKey: 'bastion-bindings-probe',
			// no Durable Object and no assets: the shape the generator could not express before
			residency: 'evict',
			bindings: {
				d1: ['DB'],
				kv: ['SESSIONS'],
				vectorize: ['INDEX'],
				ai: ['AI'],
				email: ['MAILER'],
				analytics: ['AE'],
				images: ['IMAGES']
			},
			vars: { STAGE: 'test' }
		});

		const path = join(root, 'config.capnp');
		writeFileSync(path, renderConfig(config));

		const child = spawn(workerd, ['serve', path], {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		children.push(child);
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		// a spawn that never started reads exactly like one that started and hung, and the poll
		// below would sit on it for a minute before reporting an empty stderr
		let unstarted: string | null = null;
		child.on('error', (error: NodeJS.ErrnoException) => {
			unstarted =
				error.code === 'ENOENT'
					? `${workerd} is not on this PATH; install it or point WORKERD_BINARY at one`
					: `${workerd} could not start: ${error.message}`;
		});

		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			if (unstarted !== null) throw new Error(unstarted);
			try {
				await overSocket(listen, '/health');
				return;
			} catch {
				await new Promise((r) => setTimeout(r, 400));
			}
		}
		throw new Error(`workerd never answered on ${listen}. stderr:\n${stderr}`);
	});

	it('boots a worker that has no durable object and no assets', async () => {
		const response = await overSocket(listen, '/health');
		expect(response.status).toBe(200);
		expect(response.body).toBe('ok');
		expect(response.headers['x-from']).toBe('worker');
	});

	it('accepts the extension block, which every wrapped binding depends on', () => {
		// the boot above already proves it: workerd refuses to start on an extension it cannot
		// load, so an unparseable module or a bad `wrapped` shape would have failed beforeAll
		expect(stderr).not.toMatch(/extension|wrapped|moduleName/i);
	});

	it('runs a statement through env.DB and returns real rows', async () => {
		const response = await overSocket(listen, '/rows');
		expect(response.status).toBe(200);
		const body = JSON.parse(response.body) as { rows: { name: string }[] };
		expect(body.rows[0]?.name).toBe('acme');
	});

	it('answers first() with a column rather than a row, as D1 does', async () => {
		const response = await overSocket(listen, '/first');
		expect(response.body).toBe('acme');
	});

	it('binds kv through the native designator alongside the wrapped one', async () => {
		const response = await overSocket(listen, '/kv');
		expect(response.body).toBe('v');
	});

	it('answers the worker own 404 rather than a runtime error', async () => {
		const response = await overSocket(listen, '/nope');
		expect(response.status).toBe(404);
	});

	it('returns one D1 result per statement from batch, in order', async () => {
		const response = await overSocket(listen, '/batch');
		expect(response.status).toBe(200);
		const body = JSON.parse(response.body) as { count: number; first: { a: number }[] };
		expect(body.count).toBe(2);
		expect(body.first[0]?.a).toBe(1);
	});

	it('upserts and queries through env.VECTORIZE', async () => {
		const response = await overSocket(listen, '/vector');
		expect(response.status).toBe(200);
		const body = JSON.parse(response.body) as {
			id: string;
			described: { dimensions: number; count: number };
		};
		expect(body.id).toBe('a');
		expect(body.described).toMatchObject({ dimensions: 2, count: 2 });
	});

	it('runs a model through env.AI and unwraps the result envelope', async () => {
		const response = await overSocket(listen, '/ai');
		expect(response.status).toBe(200);
		expect(JSON.parse(response.body)).toEqual({ echoed: 'stub-model' });
	});

	it('sends through env.MAILER, passing the message body through unchanged', async () => {
		const response = await overSocket(listen, '/mail');
		expect(response.status).toBe(200);
		expect(mail.sent).toHaveLength(1);
		expect(mail.sent[0]?.to).toBe('ops@example.edu');
		// byte for byte: a re-encode here is what stops a DKIM signature verifying
		expect(mail.sent[0]?.raw).toBe('Subject: hi\r\n\r\nbody');
	});

	it('records a data point through env.AE without the worker awaiting it', async () => {
		const response = await overSocket(listen, '/metric');
		expect(response.status).toBe(200);
		// writeDataPoint returns void, so the write races the response; give it a moment
		await new Promise((r) => setTimeout(r, 300));
		expect(metrics.size).toBe(1);
		expect(metrics.all('acme')[0]?.doubles).toEqual([1.5]);
	});

	it('reads image dimensions through env.IMAGES', async () => {
		const response = await overSocket(listen, '/image');
		expect(response.status).toBe(200);
		expect(JSON.parse(response.body)).toMatchObject({ format: 'png', width: 4, height: 3 });
	});

	it('routed every binding to its own socket, so nothing was misdelivered', () => {
		expect(adapterFailures).toEqual([]);
	});
});
