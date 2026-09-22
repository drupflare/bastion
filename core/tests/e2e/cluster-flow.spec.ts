import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionCookieName } from '../../src/cluster/replicate';
import { gate } from './support/gate';

/**
 * Two real boxes, on one docker network, joined into a cluster.
 *
 * Everything here needs two hosts to be true at all, which is why none of it could be asserted
 * before: a child dialling out, a control node minting a credential it later verifies, a placement
 * table crossing the wire, and a request arriving at the node that does not hold the site being
 * answered by the node that does.
 *
 * The containers reach each other by name on a user-defined network, so `node-b` dialling
 * `node-a:8787` is the same shape an operator gets from two machines on a campus LAN.
 */
const run = promisify(execFile);

const reason = gate('REQUIRE_CLUSTER');
const IMAGE = 'oven/bun:1.4';
const PINNED = '1.20260828.1';
const NETWORK = `bastion-cluster-${process.pid}`;
const NODES = ['node-a', 'node-b'] as const;
const NAME = (node: string): string => `bastion-${node}-${process.pid}`;
const SITE = 'www.acme.edu';

/**
 * The tenant's worker, which says which node answered.
 *
 * `x-who` is the whole assertion surface: a replica answering locally and a primary answering a
 * forward are otherwise indistinguishable from the client. It echoes the Host it saw for the same
 * reason the forward sets it explicitly.
 */
const worker = (node: string): string =>
	[
		'export default {',
		'  fetch(request) {',
		'    const url = new URL(request.url);',
		'    return new Response(JSON.stringify({',
		`      node: ${JSON.stringify(node)},`,
		'      host: request.headers.get("host"),',
		'      path: url.pathname,',
		'      method: request.method',
		'    }), {',
		`      headers: { "content-type": "application/json", "x-who": ${JSON.stringify(node)} }`,
		'    });',
		'  }',
		'};',
		''
	].join('\n');

const MANIFEST = JSON.stringify({
	name: 'acme',
	main: 'index.js',
	compatibility_date: '2026-08-01'
});

let prepared = false;
const work = new Map<string, string>();

async function inside(node: string, script: string): Promise<{ code: number; out: string }> {
	try {
		const { stdout, stderr } = await run('docker', ['exec', NAME(node), 'sh', '-c', script], {
			maxBuffer: 32 * 1024 * 1024
		});
		return { code: 0, out: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
	}
}

const bastion = (node: string, argv: string): Promise<{ code: number; out: string }> =>
	inside(node, `cd /work && /rig/bastion ${argv}`);

/** asks one node for a site, from inside the other, so the request crosses the docker network */
async function ask(
	from: string,
	target: string,
	path = '/serve',
	method = 'GET'
): Promise<{ status: number; who: string; forwardedTo: string | null; host: string }> {
	const answer = await inside(
		from,
		`cd /work && bun -e 'const r = await fetch("http://${target}:8080${path}", ` +
			`{ method: "${method}", headers: { host: "${SITE}" } }); ` +
			`const body = await r.text(); console.log(JSON.stringify({ status: r.status, ` +
			`who: r.headers.get("x-who"), forwardedTo: r.headers.get("x-bastion-forwarded-to"), body }));'`
	);
	const line = answer.out.trim().split('\n').pop() ?? '{}';
	const parsed = JSON.parse(line) as {
		status: number;
		who: string | null;
		forwardedTo: string | null;
		body: string;
	};
	let host = '';
	try {
		host = (JSON.parse(parsed.body) as { host: string }).host;
	} catch {
		host = '';
	}
	return {
		status: parsed.status,
		who: parsed.who ?? '',
		forwardedTo: parsed.forwardedTo,
		host
	};
}

describe.skipIf(reason !== null)(`cluster flow (${reason ?? 'enabled'})`, () => {
	beforeAll(async () => {
		const repo = join(import.meta.dirname, '..', '..', '..');
		const rig = mkdtempSync(join(tmpdir(), 'bastion-cluster-rig-'));

		const arch = process.arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64';
		await run('bun', [
			'build',
			'--compile',
			`--target=${arch}`,
			'--outfile',
			join(rig, 'bastion'),
			join(repo, 'warden', 'src', 'cli.ts')
		]);

		// one download of the linux workerd, shared by both nodes; each copies it into its own state
		await run('docker', [
			'run',
			'--rm',
			'-v',
			`${rig}:/rig`,
			'-w',
			'/rig',
			IMAGE,
			'sh',
			'-c',
			`bun add workerd@${PINNED} >/dev/null 2>&1`
		]);

		await run('docker', ['network', 'create', NETWORK]).catch(() => undefined);

		for (const node of NODES) {
			const dir = mkdtempSync(join(tmpdir(), `bastion-${node}-`));
			work.set(node, dir);
			mkdirSync(join(dir, 'bundle'), { recursive: true });
			writeFileSync(join(dir, 'bundle', 'index.js'), worker(node));
			writeFileSync(join(dir, 'bundle', 'wrangler.jsonc'), MANIFEST);

			await run('docker', [
				'run',
				'--rm',
				'-d',
				'--name',
				NAME(node),
				'--network',
				NETWORK,
				'--network-alias',
				node,
				'--privileged',
				'--cgroupns=host',
				'-v',
				`${rig}:/rig`,
				'-v',
				`${dir}:/work`,
				'-w',
				'/work',
				IMAGE,
				'sleep',
				'1800'
			]);

			const staged = await inside(
				node,
				`mkdir -p /work/state/runtime && ` +
					`cp /rig/node_modules/workerd/bin/workerd /work/state/runtime/workerd-${PINNED} && ` +
					`chmod +x /work/state/runtime/workerd-${PINNED} && echo staged`
			);
			if (!staged.out.includes('staged')) {
				throw new Error(`could not stage the runtime in ${node}: ${staged.out}`);
			}

			await bastion(node, 'init');
			await bastion(node, 'config set state /work/state');
			await bastion(node, 'config set listeners.http.address 0.0.0.0:8080');
			await bastion(node, 'config set listeners.https.address 0.0.0.0:8443');
			// a child dials this, so it binds every interface rather than loopback
			await bastion(node, 'config set listeners.management.address 0.0.0.0:8787');
			await bastion(node, `cert self-sign ${SITE}`);
			await bastion(node, 'tenant add acme');
			// `--template` reads the manifest, which declares no durable object: this worker is a
			// plain fetch handler, and inheriting the drupflare shape would bind a class it does
			// not export
			await bastion(
				node,
				`site add ${SITE} --tenant acme --bundle /work/bundle --template /work/bundle`
			);
		}
		prepared = true;
	}, 900_000);

	afterAll(async () => {
		if (!prepared) return;
		for (const node of NODES) {
			await run('docker', ['rm', '-f', NAME(node)]).catch(() => undefined);
		}
		await run('docker', ['network', 'rm', NETWORK]).catch(() => undefined);
	});

	describe('forming the cluster', () => {
		let token = '';

		it('makes node-a the control node and prints a join token', async () => {
			const answer = await bastion('node-a', 'cluster init --node node-a');
			expect(answer.code).toBe(0);
			expect(answer.out).toContain('bastion cluster join --control');
			token = (/--token (\S+)/.exec(answer.out)?.[1] ?? '').trim();
			expect(token).toMatch(/^bsj_/);
		});

		it('brings the control node up', async () => {
			const answer = await bastion('node-a', 'up');
			expect(answer.code, answer.out).toBe(0);
			await inside('node-a', 'sleep 2');
		});

		it('refuses a join carrying the wrong token', async () => {
			const answer = await bastion(
				'node-b',
				'cluster join --control node-a:8787 --token bsj_wrong --node node-b'
			);
			expect(answer.code).not.toBe(0);
			expect(answer.out).toContain('not valid');
		});

		it('leaves the refused node unclustered, rather than half joined', async () => {
			const answer = await bastion('node-b', 'cluster status');
			expect(answer.out).toContain('not in a cluster');
		});

		it('joins node-b with the real token', async () => {
			const answer = await bastion(
				'node-b',
				`cluster join --control node-a:8787 --token ${token} --node node-b`
			);
			expect(answer.code).toBe(0);
			expect(answer.out).toMatch(/role\s+child/);
			expect(answer.out).toMatch(/node\s+node-b/);
		});

		it('spends the token, so the same one cannot join a third node', async () => {
			const answer = await bastion(
				'node-b',
				`cluster join --control node-a:8787 --token ${token} --node node-c`
			);
			expect(answer.code).not.toBe(0);
			expect(answer.out).toContain('not valid');
		});

		it('lists both nodes on the control node', async () => {
			const answer = await bastion('node-a', 'cluster nodes');
			expect(answer.out).toContain('node-b');
			expect(answer.out).toContain('node-b:8080');
		});

		it('brings the child up', async () => {
			const answer = await bastion('node-b', 'up');
			expect(answer.code).toBe(0);
			await inside('node-b', 'sleep 2');
		});
	});

	describe('placing a site', () => {
		it('places it on the control node with a replica on the child', async () => {
			const answer = await bastion('node-a', `cluster place ${SITE} --replicas 1`);
			expect(answer.code).toBe(0);
			expect(answer.out).toMatch(/primary\s+node-a/);
			expect(answer.out).toMatch(/replicas\s+node-b/);
		});

		it('reaches the child on its next heartbeat', async () => {
			// the heartbeat is on a timer; this waits for the placement rather than assuming it
			for (let attempt = 0; attempt < 20; attempt += 1) {
				const answer = await bastion('node-b', 'cluster status');
				if (/sites placed here\s+1/.test(answer.out)) return;
				await inside('node-b', 'sleep 2');
			}
			throw new Error('the child never learned its placement');
		}, 120_000);

		it('reports the child as a child of node-a', async () => {
			const answer = await bastion('node-b', 'cluster status');
			expect(answer.out).toMatch(/role\s+child/);
			expect(answer.out).toMatch(/control\s+node-a:8787/);
		});
	});

	describe('routing between the nodes', () => {
		it('serves a read on the primary itself', async () => {
			const answer = await ask('node-b', 'node-a');
			expect(answer.status).toBe(200);
			expect(answer.who).toBe('node-a');
			expect(answer.forwardedTo).toBe(null);
		});

		/** the point of a replica: the read is answered where it arrived */
		it('serves a spreadable read on the replica, without forwarding', async () => {
			const answer = await ask('node-a', 'node-b');
			expect(answer.status).toBe(200);
			expect(answer.who).toBe('node-b');
			expect(answer.forwardedTo).toBe(null);
		});

		it('forwards a write from the replica to the primary', async () => {
			const answer = await ask('node-a', 'node-b', '/serve', 'POST');
			expect(answer.status).toBe(200);
			expect(answer.who).toBe('node-a');
			expect(answer.forwardedTo).toBe('node-a');
		});

		it('forwards a route that is not the serving path', async () => {
			const answer = await ask('node-a', 'node-b', '/admin');
			expect(answer.forwardedTo).toBe('node-a');
			expect(answer.who).toBe('node-a');
		});

		/**
		 * The defect this cluster is most likely to reintroduce.
		 *
		 * Drupal derives its session cookie name from the host it sees. A node that forwarded a
		 * rewritten Host would render every visitor anonymous on that path alone, deterministically,
		 * with every other assertion here still passing.
		 */
		it('forwards the host unchanged, so both nodes derive one cookie name', async () => {
			const direct = await ask('node-b', 'node-a');
			const forwarded = await ask('node-a', 'node-b', '/admin');
			expect(direct.host).toBe(SITE);
			expect(forwarded.host).toBe(SITE);
			expect(sessionCookieName(forwarded.host)).toBe(sessionCookieName(direct.host));
		});

		it('answers a request already carrying the hop header rather than forwarding it again', async () => {
			const answer = await inside(
				'node-a',
				`cd /work && bun -e 'const r = await fetch("http://node-b:8080/admin", ` +
					`{ headers: { host: "${SITE}", "x-bastion-node": "node-a" } }); ` +
					`console.log(r.status, r.headers.get("x-who"), r.headers.get("x-bastion-forwarded-to"));'`
			);
			expect(answer.out).toContain('200 node-b null');
		});
	});

	describe('tearing it down', () => {
		it('stops both nodes', async () => {
			for (const node of NODES) {
				expect((await bastion(node, 'down')).code).toBe(0);
			}
		});

		it('leaves the child able to say what it still holds', async () => {
			const answer = await bastion('node-b', 'cluster status');
			expect(answer.out).toMatch(/role\s+child/);
		});
	});
});
