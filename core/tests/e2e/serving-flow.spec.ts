import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gate } from './support/gate';

/**
 * `bastion up`, serving a real request, on a host that can actually run a tenant.
 *
 * This lane exists because ten defects sat between a green hermetic suite and the first request
 * bastion ever served, and every one of them was invisible until a real `up` ran on a real kernel:
 * an unstaged bundle, a pidfile written for a process that had died, cgroup controllers that were
 * never delegated so no limit bound, `--memory 4Gi` stored as NaN, embeds resolved against the
 * wrong directory, an https listener binding plaintext, a front door dialling a socket name the
 * generator never wrote, a missing storage directory and a stale socket that blocked every
 * restart.
 *
 * It needs Linux, so it runs in a container even on a Linux host: `solo` mode wants cgroups v2 and
 * a writable `/sys/fs/cgroup`, which needs `--privileged --cgroupns=host`. macOS cannot host it at
 * all, and `bastion doctor` says so rather than pretending otherwise.
 */
const run = promisify(execFile);

const IMAGE = 'oven/bun:1.4';
const NAME = `bastion-serving-${process.pid}`;
const PINNED = '1.20260828.1';

/**
 * The tenant's whole worker.
 *
 * `/` answers with a header the front door cannot have invented, so a 200 proves the request
 * reached this code rather than an error page. `/kv` and `/d1` exercise two bindings bastion
 * serves over unix sockets it binds itself, which is the half a worker with no bindings never
 * touches: the generated config named those addresses long before anything listened on them.
 *
 * `/d1` rather than `/sql` because `/sql` is on the front door's diagnostic deny list, so the
 * request never reaches the tenant at all.
 */
const WORKER = [
	'export default {',
	'  async fetch(request, env) {',
	'    const url = new URL(request.url);',
	'    if (url.pathname === "/kv") {',
	'      await env.NOTES.put("greeting", "from the kv adapter");',
	'      return new Response(await env.NOTES.get("greeting"));',
	'    }',
	'    if (url.pathname === "/d1") {',
	'      await env.DB.prepare("CREATE TABLE IF NOT EXISTS t (v TEXT)").run();',
	'      await env.DB.prepare("INSERT INTO t (v) VALUES (?)").bind("from d1").run();',
	'      const read = await env.DB.prepare("SELECT v FROM t LIMIT 1").all();',
	'      return new Response(read.results[0].v);',
	'    }',
	'    return new Response("served by the tenant", { headers: { "x-tenant": "acme" } });',
	'  }',
	'};'
].join('\n');

/** what an operator already has beside a Worker, read rather than restated in bastion vocabulary */
const MANIFEST = JSON.stringify({
	name: 'acme',
	main: 'index.js',
	compatibility_date: '2026-08-01',
	kv_namespaces: [{ binding: 'NOTES', id: 'notes' }],
	d1_databases: [{ binding: 'DB', database_name: 'acme' }]
});

const reason = gate('REQUIRE_SERVING');
let prepared: string | null = null;

/** runs one command inside the container and never throws, so a spec asserts on the outcome */
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

/** every bastion invocation, with the PATH the rig mounts it on */
const bastion = (argv: string): Promise<{ code: number; out: string }> =>
	inside(`cd /work && export PATH=/rig:$PATH && bastion ${argv} 2>&1`);

/**
 * Counts live runtime processes by resolving each `/proc/<pid>/exe`, never by matching a cmdline.
 *
 * A `grep` over every cmdline under `/proc` counts the probe itself: the pattern sits in the argv
 * of the shell running it and of the grep, so a container with nothing running reads two or more
 * and the assertion can only be written around its own noise. An exe symlink cannot match a shell.
 */
async function runtimeProcesses(): Promise<number> {
	const answer = await inside(
		'n=0; for e in /proc/[0-9]*/exe; do case "$(readlink $e 2>/dev/null)" in ' +
			'*/workerd-*) n=$((n+1));; esac; done; echo $n'
	);
	return Number(answer.out.trim());
}

afterAll(async () => {
	if (prepared === null) return;
	// the container holds a running bastion and a workerd; removing it is the teardown
	await run('docker', ['rm', '-f', NAME]).catch(() => undefined);
});

describe.skipIf(reason !== null)(`serving flow (${reason ?? 'enabled'})`, () => {
	beforeAll(async () => {
		const rig = mkdtempSync(join(tmpdir(), 'bastion-rig-'));
		const work = mkdtempSync(join(tmpdir(), 'bastion-work-'));
		prepared = rig;

		// the container is linux; cross compile for whatever it will be running on
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

		mkdirSync(join(work, 'bundle'), { recursive: true });
		writeFileSync(join(work, 'bundle', 'index.js'), WORKER);
		writeFileSync(join(work, 'bundle', 'wrangler.jsonc'), MANIFEST);

		// --privileged --cgroupns=host is what makes /sys/fs/cgroup writable, which `solo` needs
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
			`cd /work && bun add workerd@${PINNED} >/dev/null 2>&1 && ` +
				`mkdir -p state/runtime && ` +
				`cp node_modules/workerd/bin/workerd state/runtime/workerd-${PINNED} && ` +
				`chmod +x state/runtime/workerd-${PINNED} && echo staged`
		);
		if (!staged.out.includes('staged')) {
			throw new Error(`could not stage the runtime inside the container: ${staged.out}`);
		}
	}, 600_000);

	describe('a first install on a host that can run it', () => {
		it('writes a configuration', async () => {
			const answer = await bastion('init');
			expect(answer.code).toBe(0);
		});

		it('reports the mode as available, which macOS cannot', async () => {
			await bastion('config set state /work/state');
			const answer = await bastion('doctor');
			expect(answer.out).toContain('platform             linux');
			expect(answer.out).toMatch(/mode available here\s+yes/);
		});

		it('takes a memory limit written the way the manual writes it', async () => {
			await bastion('config set listeners.https.address 127.0.0.1:8443');
			await bastion('config set listeners.http.address 127.0.0.1:8080');
			await bastion('config set listeners.management.address 127.0.0.1:8787');
			const answer = await bastion('tenant add acme --cpu 1 --memory 512Mi');
			expect(answer.code).toBe(0);
			const listed = await bastion('tenant list');
			expect(listed.out).toContain('536870912');
			expect(listed.out).not.toContain('NaN');
		});

		it('adds a site pointing at a bundle directory', async () => {
			const answer = await bastion(
				'site add www.example.edu --tenant acme --bundle /work/bundle ' +
					'--template /work/bundle'
			);
			expect(answer.code).toBe(0);
		});

		it('reads the bindings out of the manifest the operator already had', async () => {
			const answer = await bastion('site show www.example.edu --json');
			expect(answer.out).toContain('NOTES');
			expect(answer.out).toContain('DB');
		});

		it('still validates', async () => {
			expect((await bastion('config validate')).code).toBe(0);
		});
	});

	describe('refusals that stop a broken start', () => {
		/**
		 * Binding https with no keypair served cleartext on the port that exists to encrypt, and
		 * reported itself as https while doing it.
		 *
		 * The refusal happens inside the detached `serve`, so it lands in the log rather than on
		 * this terminal. `up` reads it back: an operator whose certificate is missing should not
		 * have to open a file to find out which setting is wrong.
		 */
		it('refuses to bring up an https listener with no certificate', async () => {
			const answer = await bastion('up');
			expect(answer.out).toMatch(/no certificate/);
			expect(answer.out).toContain('bastion cert issue');
		});

		/**
		 * The refusal fires after the tenants have started, and they used to stay up.
		 *
		 * workerd kept its socket so the parent could not exit, `bastion up` never returned, and the
		 * startup grace read the live child as a healthy start and printed a pid for a box that had
		 * refused to come up.
		 */
		it('leaves no tenant running after that refusal', async () => {
			expect(await runtimeProcesses()).toBe(0);
		});

		it('leaves no pidfile claiming it is up', async () => {
			const answer = await inside('ls /work/state/bastion.pid 2>/dev/null | wc -l');
			expect(answer.out.trim()).toBe('0');
		});
	});

	describe('bringing it up', () => {
		it('self-signs a certificate', async () => {
			expect((await bastion('cert self-sign www.example.edu')).code).toBe(0);
		});

		/**
		 * `up` runs in the foreground here, with its output captured, and has to come back.
		 *
		 * It spawned `serve` with inherited stdio, so the child held this process's stdout and a
		 * caller reading that output never got EOF: `timeout 30 bastion up` printed
		 * `bastion is running as pid 541` and exited 124. An interactive shell hid it, because a tty
		 * is not a pipe, so it only bit a provisioning script, `ssh box bastion up`, CI or this lane
		 * -- which is why this no longer backgrounds it.
		 */
		it('starts, returns, and reports every listener it bound', async () => {
			const answer = await bastion('up');
			expect(answer.code).toBe(0);
			expect(answer.out).toContain('bastion is running as pid');
			expect(answer.out).toContain('logging to /work/state/logs/serve.log');
		});

		it('put the startup output in that log rather than nowhere', async () => {
			await inside('sleep 5');
			const answer = await inside('cat /work/state/logs/serve.log');
			expect(answer.out).toContain('mode solo');
			expect(answer.out).toContain('1 tenants running');
			expect(answer.out).toMatch(/http on 127\.0\.0\.1:8080/);
			expect(answer.out).toMatch(/https on 127\.0\.0\.1:8443/);
		});

		it('leaves workerd listening on the socket the front door dials', async () => {
			const answer = await inside('ls /work/state/tenants/acme/http.sock');
			expect(answer.code).toBe(0);
		});

		/**
		 * The whole point of the lane.
		 *
		 * The header comes from the tenant's own worker, so a front door answering out of its own
		 * error path cannot produce it.
		 */
		it('serves a request through the front door from the tenant worker', async () => {
			const answer = await inside(
				`cd /work && bun -e 'const r = await fetch("http://127.0.0.1:8080/", ` +
					`{ headers: { host: "www.example.edu" }, redirect: "manual" }); ` +
					`console.log(r.status, r.headers.get("x-tenant"), await r.text());'`
			);
			expect(answer.out).toContain('200');
			expect(answer.out).toContain('acme');
			expect(answer.out).toContain('served by the tenant');
		});

		/** one request per binding, through the front door, so nothing is asserted from inside */
		const through = (path: string) =>
			inside(
				`cd /work && bun -e 'const r = await fetch("http://127.0.0.1:8080${path}", ` +
					`{ headers: { host: "www.example.edu" } }); ` +
					`console.log(r.status, await r.text());'`
			);

		/**
		 * The generated config named every adapter socket and nothing ever bound one.
		 *
		 * workerd dials an `external` service lazily, so the tenant started, answered the request
		 * above and looked healthy; the first KV read met a connection error instead. A worker with
		 * no bindings is what hid it, which is exactly what this lane used to deploy.
		 */
		it('reads and writes KV over the socket bastion binds for it', async () => {
			const answer = await through('/kv');
			expect(answer.out).toContain('200');
			expect(answer.out).toContain('from the kv adapter');
		});

		// D1 has no capnp field at all, so this one also proves the wrapped shim reaches the socket
		it('queries D1 through the wrapped binding', async () => {
			const answer = await through('/d1');
			expect(answer.out).toContain('200');
			expect(answer.out).toContain('from d1');
		});

		/**
		 * The diagnostic set is refused at the front door, outside the site's control.
		 *
		 * The worker's own `PW_DIAGNOSTICS` gates `/php`, `/sql`, `/restore`, `/replica` and `/plan`
		 * as one switch, and it is KV-overridable, so a compromised site can flip it. bastion
		 * refuses the paths per tenant before routing, on a header the site never sees.
		 */
		it('refuses a diagnostic route before it reaches the tenant', async () => {
			const answer = await through('/sql');
			expect(answer.out).toContain('404');
			expect(answer.out).toContain('diagnostic routes are off');
		});

		it('keeps each tenant store under that tenant rather than a shared box path', async () => {
			const answer = await inside('ls /work/state/tenants/acme/ && ls /var/lib/bastion 2>&1');
			expect(answer.out).toContain('kv.sqlite');
			expect(answer.out).toMatch(/No such file|^$/m);
		});

		it('applies the cpu limit to the tenant cgroup rather than only writing it down', async () => {
			const answer = await inside('cat /sys/fs/cgroup/bastion.slice/tenant-acme/cpu.max');
			expect(answer.out.trim()).toBe('100000 100000');
		});

		it('applies the memory limit too', async () => {
			const answer = await inside('cat /sys/fs/cgroup/bastion.slice/tenant-acme/memory.max');
			expect(answer.out.trim()).toBe('536870912');
		});

		/**
		 * `status` is the first command after `up` and the first command when a site is down.
		 *
		 * It printed the configured tenant table and nothing else, so it read identically on a
		 * running box and a stopped one and exited 0 either way.
		 */
		it('reports the box as running, with its pid and listeners', async () => {
			const answer = await bastion('status');
			expect(answer.out).toMatch(/running\s+yes, pid \d+/);
			expect(answer.out).toContain('127.0.0.1:8787');
		});

		it('marks the tenant up in that table', async () => {
			const answer = await bastion('status');
			expect(answer.out.split('\n').find((line) => line.startsWith('acme'))).toContain('up');
		});

		/**
		 * The probe asks THIS box, not whatever dns answers for the name.
		 *
		 * It built the url from the hostname, so in this container `www.example.edu` resolved to
		 * IANA's example server, the probe read its 200 over the public internet and reported the
		 * site answering. During a migration that name still points at the machine being migrated
		 * off, which is the one answer the command exists to avoid giving.
		 */
		it('probes the site against the local listener and says so', async () => {
			const answer = await bastion('site probe www.example.edu');
			expect(answer.code).toBe(0);
			expect(answer.out).toMatch(/dialled\s+http:\/\/127\.0\.0\.1:8080\//);
			expect(answer.out).toContain('this box served the site');
		});

		it('404s a host no tenant holds, without reaching a tenant', async () => {
			const answer = await inside(
				`cd /work && bun -e 'const r = await fetch("http://127.0.0.1:8080/", ` +
					`{ headers: { host: "nobody.example.edu" }, redirect: "manual" }); ` +
					`console.log(r.status, r.headers.get("x-tenant"));'`
			);
			expect(answer.out).toContain('404');
			expect(answer.out).toContain('null');
		});
	});

	/**
	 * A tenant whose runtime dies has to come back, and the supervisor that does it was dead code.
	 *
	 * `TenantSupervisor.run` is the loop -- one spawn, await the exit, back off, spawn again, open
	 * the breaker after enough failures. `Runtime.startTenant` called `start()` instead, which
	 * spawns once and returns, so nothing anywhere called `run`. Measured in a container: `kill -9`
	 * the tenant's workerd and eight seconds later there were zero runtime processes and every
	 * request answered 502, while `status` still read the tenant as up.
	 *
	 * A kill is the realistic shape of this: an OOM kill, a segfault, an operator killing the wrong
	 * pid. None of them should take a site down until somebody notices.
	 */
	describe('a tenant whose runtime is killed', () => {
		it('is serving to begin with', async () => {
			const answer = await bastion('site probe www.example.edu');
			expect(answer.code).toBe(0);
		});

		it('comes back after a kill -9', async () => {
			const before = await inside(
				'for e in /proc/[0-9]*/exe; do case "$(readlink $e 2>/dev/null)" in ' +
					'*/workerd-*) echo ${e#/proc/} | cut -d/ -f1;; esac; done | head -1'
			);
			const pid = before.out.trim();
			expect(pid).toMatch(/^\d+$/);

			await inside(`kill -9 ${pid}`);
			await inside('sleep 8');
			expect(await runtimeProcesses()).toBe(1);

			const after = await inside(
				'for e in /proc/[0-9]*/exe; do case "$(readlink $e 2>/dev/null)" in ' +
					'*/workerd-*) echo ${e#/proc/} | cut -d/ -f1;; esac; done | head -1'
			);
			expect(after.out.trim()).not.toBe(pid);
		});

		it('serves again, without an operator touching anything', async () => {
			const answer = await inside(
				`cd /work && bun -e 'const r = await fetch("http://127.0.0.1:8080/", ` +
					`{ headers: { host: "www.example.edu" } }); console.log(r.status, await r.text());'`
			);
			expect(answer.out).toContain('200');
			expect(answer.out).toContain('served by the tenant');
		});

		/** a restarted process with no cgroup is worst exactly when the kill was an OOM */
		it('puts the replacement back under the tenant cgroup', async () => {
			const answer = await inside(
				'cat /sys/fs/cgroup/bastion.slice/tenant-acme/cgroup.procs'
			);
			const held = answer.out.trim().split('\n').filter(Boolean);
			expect(held.length).toBeGreaterThan(0);

			const running = await inside(
				'for e in /proc/[0-9]*/exe; do case "$(readlink $e 2>/dev/null)" in ' +
					'*/workerd-*) echo ${e#/proc/} | cut -d/ -f1;; esac; done | head -1'
			);
			expect(held).toContain(running.out.trim());
		});

		it('still reads as up, because status reads a pid rather than a socket file', async () => {
			const answer = await bastion('status');
			expect(answer.out.split('\n').find((line) => line.startsWith('acme'))).toContain('up');
		});
	});

	describe('stopping and starting again', () => {
		it('stops', async () => {
			expect((await bastion('down')).code).toBe(0);
		});

		/**
		 * A unix socket outlives the process that bound it.
		 *
		 * workerd answers `Address already in use` rather than replacing one, so a kill, an OOM or a
		 * power loss left a file that stopped the tenant starting ever again. This is the restart
		 * that used to fail.
		 */
		it('starts again over the socket the previous run left behind', async () => {
			await inside('touch /work/state/tenants/acme/http.sock');
			await inside('rm -f /work/state/logs/serve.log');
			expect((await bastion('up')).code).toBe(0);
			await inside('sleep 5');
			const answer = await inside('cat /work/state/logs/serve.log');
			expect(answer.out).not.toMatch(/Address already in use/);
			expect(answer.out).toContain('1 tenants running');
		});

		it('serves again after the restart', async () => {
			const answer = await inside(
				`cd /work && bun -e 'const r = await fetch("http://127.0.0.1:8080/", ` +
					`{ headers: { host: "www.example.edu" } }); console.log(r.status, await r.text());'`
			);
			expect(answer.out).toContain('200');
			expect(answer.out).toContain('served by the tenant');
		});

		it('stops again and leaves no tenant process behind', async () => {
			await bastion('down');
			await inside('sleep 2');
			expect(await runtimeProcesses()).toBe(0);
		});
	});
	/** what an operator does when a change needs picking up, and what is left when they finish */
	describe('restarting and tearing down', () => {
		it('restarts from a stopped box, saying there was nothing to stop', async () => {
			const answer = await bastion('restart');
			expect(answer.code).toBe(0);
			expect(answer.out).toContain('not running');
			expect(answer.out).toContain('bastion is running as pid');
		});

		it('restarts a running box, stopping the old one first', async () => {
			await inside('sleep 4');
			const answer = await bastion('restart');
			expect(answer.code).toBe(0);
			expect(answer.out).toMatch(/asked pid \d+ to stop/);
			expect(answer.out).toContain('bastion is running as pid');
		});

		it('serves again after the restart', async () => {
			await inside('sleep 4');
			const answer = await inside(
				`cd /work && bun -e 'const r = await fetch("http://127.0.0.1:8080/", ` +
					`{ headers: { host: "www.example.edu" } }); console.log(r.status, await r.text());'`
			);
			expect(answer.out).toContain('200');
			expect(answer.out).toContain('served by the tenant');
		});

		it('leaves exactly one bastion behind, not one per restart', async () => {
			const answer = await inside(
				'n=0; for e in /proc/[0-9]*/exe; do case "$(readlink $e 2>/dev/null)" in ' +
					'*/rig/bastion) n=$((n+1));; esac; done; echo $n'
			);
			expect(Number(answer.out.trim())).toBe(1);
		});

		it('stops, and reports the box as down', async () => {
			expect((await bastion('down')).code).toBe(0);
			await inside('sleep 2');
			const answer = await bastion('status');
			expect(answer.out).toMatch(/running\s+no/);
		});

		/** the socket file outlives the process, and used to read as a tenant still serving */
		it('marks no tenant up once the box is down, whatever is still on disk', async () => {
			const answer = await bastion('status');
			expect(answer.out.split('\n').find((line) => line.startsWith('acme'))).toContain(
				'down'
			);
		});

		it('refuses the probe rather than reporting a site nobody can reach', async () => {
			const answer = await bastion('site probe www.example.edu');
			expect(answer.code).toBe(3);
			expect(answer.out).toContain('is bastion running?');
		});

		it('leaves no process, no pidfile and no listener', async () => {
			expect(await runtimeProcesses()).toBe(0);
			const pidfile = await inside('ls /work/state/bastion.pid 2>/dev/null | wc -l');
			expect(pidfile.out.trim()).toBe('0');
			const listening = await inside(
				`cd /work && bun -e 'try { await fetch("http://127.0.0.1:8080/"); console.log("open"); } ` +
					`catch { console.log("closed"); }'`
			);
			expect(listening.out).toContain('closed');
		});

		/**
		 * A teardown that took the state with it would lose every site on a restart.
		 *
		 * `down` stops the box; removing what a tenant owns is `tenant rm --purge`, which refuses
		 * without a verified backup. These are different commands on purpose.
		 */
		it('keeps the state a restart needs', async () => {
			const answer = await inside('ls /work/state');
			for (const kept of ['certs', 'logs', 'runtime', 'tenants']) {
				expect(answer.out).toContain(kept);
			}
		});
	});

	/**
	 * A bundle that cannot boot, which is what a bad deploy looks like from the box.
	 *
	 * The restart loop must not become an infinite one: five failures inside the window open the
	 * breaker and the tenant is held rather than respawned forever. Asserted here rather than only
	 * in the supervisor's own spec, because the loop reached production for the first time in this
	 * pass and a breaker that never opens is a box spawning workerd in a tight loop.
	 *
	 * Left until last: it deliberately breaks the site every other section depends on.
	 */
	describe('a tenant that cannot boot', () => {
		it('starts, and does not sit respawning forever', async () => {
			await inside('rm -f /work/state/logs/serve.log');
			// a config workerd parses and refuses to run: the entrypoint is not a module it can load
			await inside('echo "this is not javascript {{{" > /work/bundle/index.js');
			expect((await bastion('up')).code).toBe(0);
			await inside('sleep 25');
			expect(await runtimeProcesses()).toBe(0);
		});

		it('opens the breaker and says how many failures bought it', async () => {
			const answer = await inside('cat /work/state/logs/serve.log');
			expect(answer.out).toMatch(/workerd exited \d+, attempt \d+/);
			expect(answer.out).toMatch(/failures in \d+ms, holding for \d+ms/);
		});

		it('names the tenant and the command that clears it', async () => {
			const answer = await inside('cat /work/state/logs/serve.log');
			expect(answer.out).toContain('tenant acme is quarantined');
			expect(answer.out).toContain('bastion repair');
		});

		it('reads as down rather than up while it is held', async () => {
			const answer = await bastion('status');
			expect(answer.out.split('\n').find((line) => line.startsWith('acme'))).toContain(
				'down'
			);
		});

		it('stops cleanly even from a quarantine', async () => {
			expect((await bastion('down')).code).toBe(0);
			await inside('sleep 2');
			expect(await runtimeProcesses()).toBe(0);
		});
	});
});
