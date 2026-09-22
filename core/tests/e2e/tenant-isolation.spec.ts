import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gate } from './support/gate';

/**
 * Two tenants on one box, which is the claim the whole isolation model rests on.
 *
 * "One workerd process per tenant, in every mode" is what makes a cgroup limit bind to something,
 * lets a tenant change restart one tenant rather than the box, and keeps a Durable Object
 * consistency domain per tenant. Every part of that had only ever been asserted against generated
 * text or a single tenant: nothing had started two.
 *
 * Separate from the serving lane because it is a different question and needs its own box. That one
 * proves a site is served; this one proves the wall between two of them.
 */
const run = promisify(execFile);

const IMAGE = 'oven/bun:1.4';
const NAME = `bastion-isolation-${process.pid}`;
const PINNED = '1.20260828.1';
const ACKNOWLEDGE = '--i-understand-this-is-not-multi-tenant-safe';

/** each tenant answers with its own name, so a response cannot be attributed to the wrong one */
const worker = (who: string): string =>
	`export default { async fetch() { return new Response("from ${who}", ` +
	`{ headers: { "x-who": "${who}" } }); } };\n`;

const reason = gate('REQUIRE_SERVING');
let prepared = false;

async function inside(script: string): Promise<{ code: number; out: string }> {
	try {
		const { stdout, stderr } = await run('docker', ['exec', NAME, 'sh', '-c', script], {
			maxBuffer: 32 * 1024 * 1024
		});
		return { code: 0, out: `${stdout}${stderr}` };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failure.code ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
	}
}

const bastion = (argv: string): Promise<{ code: number; out: string }> =>
	inside(`cd /work && export PATH=/rig:$PATH && bastion ${argv} 2>&1`);

/** every runtime process, by exe symlink rather than by cmdline, which would match the probe */
async function runtimeProcesses(): Promise<number> {
	const answer = await inside(
		'n=0; for e in /proc/[0-9]*/exe; do case "$(readlink $e 2>/dev/null)" in ' +
			'*/workerd-*) n=$((n+1));; esac; done; echo $n'
	);
	return Number(answer.out.trim());
}

/** the pids one tenant's cgroup holds, which is the only place a per-tenant limit can bind */
async function heldBy(tenant: string): Promise<string[]> {
	const answer = await inside(`cat /sys/fs/cgroup/bastion.slice/tenant-${tenant}/cgroup.procs`);
	return answer.out.trim().split('\n').filter(Boolean);
}

const served = (host: string): Promise<{ code: number; out: string }> =>
	inside(
		`cd /work && bun -e 'const r = await fetch("http://127.0.0.1:8080/", ` +
			`{ headers: { host: "${host}" } }); ` +
			`console.log(r.status, r.headers.get("x-who"), await r.text());'`
	);

afterAll(async () => {
	if (!prepared) return;
	await run('docker', ['rm', '-f', NAME]).catch(() => undefined);
});

describe.skipIf(reason !== null)(`tenant isolation (${reason ?? 'enabled'})`, () => {
	beforeAll(async () => {
		const rig = mkdtempSync(join(tmpdir(), 'bastion-rig-'));
		const work = mkdtempSync(join(tmpdir(), 'bastion-work-'));
		prepared = true;

		const arch = process.arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64';
		const repo = join(import.meta.dirname, '..', '..', '..');
		await run('bun', [
			'build',
			'--compile',
			`--target=${arch}`,
			'--outfile',
			join(rig, 'bastion'),
			join(repo, 'warden', 'src', 'cli.ts')
		]);

		for (const who of ['acme', 'beta']) {
			mkdirSync(join(work, who), { recursive: true });
			writeFileSync(join(work, who, 'index.js'), worker(who));
		}

		await run('docker', [
			'run',
			'--rm',
			'-d',
			'--name',
			NAME,
			'--privileged',
			'--cgroupns=host',
			'-v',
			`${rig}:/rig`,
			'-v',
			`${work}:/work`,
			'-w',
			'/work',
			IMAGE,
			'sleep',
			'1800'
		]);

		const staged = await inside(
			`cd /work && bun add workerd@${PINNED} >/dev/null 2>&1 && mkdir -p state/runtime && ` +
				`cp node_modules/workerd/bin/workerd state/runtime/workerd-${PINNED} && ` +
				`chmod +x state/runtime/workerd-${PINNED} && echo staged`
		);
		if (!staged.out.includes('staged')) {
			throw new Error(`could not stage the runtime inside the container: ${staged.out}`);
		}

		await bastion('init');
		await bastion('config set state /work/state');
		await bastion('config set listeners.http.address 127.0.0.1:8080');
		await bastion('config set listeners.https.address 127.0.0.1:8443');
		await bastion('config set listeners.management.address 127.0.0.1:8787');
		// deliberately different limits, so a cgroup assertion cannot pass by reading the other one
		await bastion('tenant add acme --cpu 1 --memory 512Mi');
		await bastion('tenant add beta --cpu 2 --memory 256Mi');
		await bastion('site add www.acme.edu --tenant acme --bundle /work/acme');
		await bastion('site add www.beta.edu --tenant beta --bundle /work/beta');
		await bastion('cert self-sign www.acme.edu');
		await bastion('cert self-sign www.beta.edu');
	}, 600_000);

	/**
	 * The refusal, and the escape hatch it names.
	 *
	 * `solo` puts a correctness boundary around a tenant rather than a security one, so two tenants
	 * behind it is a decision an operator makes deliberately. The message told them to pass
	 * `--i-understand-this-is-not-multi-tenant-safe`, which was registered on no command: following
	 * the instruction answered `unknown option` and the escape hatch did not exist.
	 */
	describe('starting two tenants in a mode that is not multi-tenant safe', () => {
		it('refuses, naming the boundary and the alternative', async () => {
			const answer = await bastion('up');
			expect(answer.code).toBe(2);
			expect(answer.out).toContain('not multi-tenant safe');
			expect(answer.out).toContain('--mode isolated');
		});

		it('is not satisfied by --yes, which a script types without reading', async () => {
			const answer = await bastion('up --yes');
			expect(answer.code).toBe(2);
			expect(answer.out).toContain('not multi-tenant safe');
		});

		it('accepts the flag the refusal names, rather than answering unknown option', async () => {
			const answer = await bastion(`up ${ACKNOWLEDGE}`);
			expect(answer.out).not.toContain('unknown option');
			expect(answer.code).toBe(0);
			expect(answer.out).toContain('bastion is running as pid');
		});

		it('still warns, because acknowledging is not the same as it being safe', async () => {
			const answer = await inside('cat /work/state/logs/serve.log');
			expect(answer.out).toContain('not multi-tenant safe');
		});
	});

	describe('one process per tenant', () => {
		it('runs two runtimes, not one shared between them', async () => {
			await inside('sleep 6');
			expect(await runtimeProcesses()).toBe(2);
		});

		it('reports both as up', async () => {
			const answer = await bastion('status');
			const rows = answer.out.split('\n');
			expect(rows.find((line) => line.startsWith('acme'))).toContain('up');
			expect(rows.find((line) => line.startsWith('beta'))).toContain('up');
		});

		it('routes each hostname to the tenant that holds it', async () => {
			const acme = await served('www.acme.edu');
			expect(acme.out).toContain('from acme');
			const beta = await served('www.beta.edu');
			expect(beta.out).toContain('from beta');
		});

		/** one cgroup each, with the limits that tenant asked for and not the other's */
		it('binds each tenant s own limits, which one shared process could not', async () => {
			const acme = await inside('cat /sys/fs/cgroup/bastion.slice/tenant-acme/memory.max');
			const beta = await inside('cat /sys/fs/cgroup/bastion.slice/tenant-beta/memory.max');
			expect(acme.out.trim()).toBe('536870912');
			expect(beta.out.trim()).toBe('268435456');

			const acmeCpu = await inside('cat /sys/fs/cgroup/bastion.slice/tenant-acme/cpu.max');
			const betaCpu = await inside('cat /sys/fs/cgroup/bastion.slice/tenant-beta/cpu.max');
			expect(acmeCpu.out.trim()).toBe('100000 100000');
			expect(betaCpu.out.trim()).toBe('200000 100000');
		});

		it('puts each runtime in its own cgroup and neither in both', async () => {
			const acme = await heldBy('acme');
			const beta = await heldBy('beta');
			expect(acme).toHaveLength(1);
			expect(beta).toHaveLength(1);
			expect(acme[0]).not.toBe(beta[0]);
		});
	});

	/**
	 * The blast radius, which is the reason for one process per tenant.
	 *
	 * A tenant that dies must not take its neighbour with it, and the neighbour must not even be
	 * restarted: a restart drops every in-memory Durable Object it held, so a shared runtime would
	 * turn one tenant's crash into the other's data loss.
	 */
	describe('one tenant dying', () => {
		it('leaves the other serving throughout', async () => {
			const before = (await heldBy('beta'))[0];
			await inside(`kill -9 ${(await heldBy('acme'))[0] ?? ''}`);

			const beta = await served('www.beta.edu');
			expect(beta.out).toContain('200');
			expect(beta.out).toContain('from beta');
			expect((await heldBy('beta'))[0]).toBe(before);
		});

		it('brings the dead one back on its own', async () => {
			await inside('sleep 8');
			const acme = await served('www.acme.edu');
			expect(acme.out).toContain('200');
			expect(acme.out).toContain('from acme');
		});

		it('leaves two runtimes again, not three and not one', async () => {
			expect(await runtimeProcesses()).toBe(2);
		});

		it('never restarted the neighbour, which would have dropped its objects', async () => {
			const answer = await inside('cat /work/state/logs/serve.log');
			expect(answer.out).toMatch(/tenant acme: workerd exited/);
			expect(answer.out).not.toMatch(/tenant beta: workerd exited/);
		});
	});

	/**
	 * The front door terminating TLS, which is the reason it exists at all.
	 *
	 * workerd carries exactly one `Keypair` per `TlsOptions` and its schema has an open TODO for
	 * SNI-based selection, so one cert per socket cannot serve a multi-hostname box. bastion
	 * terminates instead and workerd sits behind it on a unix socket. Every lane so far asserted the
	 * https listener was bound and then made every request over http, so nothing had completed a
	 * handshake against bastion.
	 *
	 * The chain is not verified because the point is WHICH certificate came back: these are
	 * self-signed seconds earlier by the box under test, over loopback inside a throwaway
	 * container, so trusting them first would test the container's trust store instead.
	 */
	describe('serving over TLS', () => {
		beforeAll(async () => {
			// the certificates are self-signed for these names, so the names have to resolve here
			await inside('printf "127.0.0.1 www.acme.edu www.beta.edu\\n" >> /etc/hosts');
		});

		it('presents each hostname its own certificate from one listener', async () => {
			const answer = await inside(
				`cd /work && bun -e 'const tls = await import("node:tls"); ` +
					`const peer = (servername) => new Promise((res, rej) => { ` +
					`const s = tls.connect({ host: "127.0.0.1", port: 8443, servername, ` +
					`rejectUnauthorized: false }, () => { ` +
					`res(s.getPeerCertificate().subject.CN); s.destroy(); }); s.on("error", rej); }); ` +
					`for (const n of ["www.acme.edu", "www.beta.edu"]) console.log(n, await peer(n));'`
			);
			expect(answer.out).toContain('www.acme.edu www.acme.edu');
			expect(answer.out).toContain('www.beta.edu www.beta.edu');
		});

		it('serves each site over https, routed by the same name it was asked for', async () => {
			const answer = await inside(
				`cd /work && bun -e 'for (const h of ["www.acme.edu", "www.beta.edu"]) { ` +
					`const r = await fetch("https://" + h + ":8443/", ` +
					`{ tls: { rejectUnauthorized: false } }); ` +
					`console.log(h, r.status, r.headers.get("x-who")); }'`
			);
			expect(answer.out).toContain('www.acme.edu 200 acme');
			expect(answer.out).toContain('www.beta.edu 200 beta');
		});
	});

	/**
	 * `reload` compares what is configured against what is RUNNING, then swaps what moved.
	 *
	 * It wrote the baseline digest itself, so the first run on any box reported every tenant as
	 * changed and the second reported none: the answer depended on whether `reload` had been run
	 * before. And it said `1 tenant will restart`, exited 0, and restarted nothing, so an operator
	 * who raised a memory limit was told it had been applied and kept serving on the old one.
	 *
	 * The swap is per tenant because the limit lives on a per-tenant cgroup, and because the
	 * tenants that did not move keep their Durable Objects resident. Reading `memory.max` off the
	 * running cgroup is the only assertion that distinguishes an applied limit from a reported one.
	 */
	describe('reloading what is out of date', () => {
		let before: string[] = [];

		it('reads a freshly started box as running what is on disk', async () => {
			const answer = await bastion('reload --check');
			expect(answer.code).toBe(0);
			expect(answer.out).toContain('running the configuration on disk');
		});

		it('names the tenant whose configuration moved, and only that one', async () => {
			before = await heldBy('beta');
			await bastion('tenant limits acme --memory 1Gi');
			const answer = await bastion('reload --check');
			expect(answer.out).toMatch(/out of date\s+acme/);
			expect(answer.out).toMatch(/unchanged\s+beta/);
		});

		it('exits 3 under --check, because something configured is not running', async () => {
			const answer = await bastion('reload --check');
			expect(answer.code).toBe(3);
			expect(answer.out).toContain('without --check');
		});

		it('swaps that tenant and names what it swapped', async () => {
			const answer = await bastion('reload');
			expect(answer.code).toBe(0);
			expect(answer.out).toMatch(/swapped\s+acme/);
			expect(answer.out).toContain('1 tenant swapped');
		});

		it('puts the new limit on the cgroup the tenant is actually running under', async () => {
			const answer = await inside('cat /sys/fs/cgroup/bastion.slice/tenant-acme/memory.max');
			expect(answer.out.trim()).toBe('1073741824');
		});

		it('leaves the other tenant on the process it already had', async () => {
			expect(await heldBy('beta')).toEqual(before);
		});

		it('still serves both sites afterwards', async () => {
			expect((await served('www.acme.edu')).out).toContain('200 acme');
			expect((await served('www.beta.edu')).out).toContain('200 beta');
		});

		it('reads clean on the next run, so the digest moved with the swap', async () => {
			const answer = await bastion('reload --check');
			expect(answer.code).toBe(0);
			expect(answer.out).toContain('running the configuration on disk');
		});
	});

	describe('stopping', () => {
		it('stops both tenants, not just the first', async () => {
			expect((await bastion('down')).code).toBe(0);
			await inside('sleep 3');
			expect(await runtimeProcesses()).toBe(0);
		});

		it('reports both as down', async () => {
			const answer = await bastion('status');
			const rows = answer.out.split('\n');
			expect(rows.find((line) => line.startsWith('acme'))).toContain('down');
			expect(rows.find((line) => line.startsWith('beta'))).toContain('down');
		});
	});
});
