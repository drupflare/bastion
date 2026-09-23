import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROOT_MODE, chrootFor, GUEST_PATHS } from '../../src/isolation/firecracker';
import { gate } from './support/gate';

/**
 * A site served from inside a microVM, which is the claim `isolated` exists to make.
 *
 * Nothing in the serving path ever called `create`: `sandboxArgv` returned the command unwrapped
 * because the VM was said to be the boundary, and `isolated` therefore ran workerd on the host
 * with less containment than `hardened`. Every spec passed the whole time, which is why the
 * driver's own assertions live here rather than against a guest booted by a spec alone.
 *
 * What has to be true here and nowhere else: workerd runs in the guest, the front door reaches it
 * over vsock rather than a unix socket, and an adapter call comes back OUT of the guest to a
 * handler bastion bound on the host side of that same vsock.
 */
const run = promisify(execFile);

const IMAGE = 'oven/bun:1.4';
const NAME = `bastion-mvserve-${process.pid}`;
const RIG = process.env.BASTION_KVM_RIG ?? join(process.env.HOME ?? '', 'bastion-rig', 'fc');
const KERNEL = 'vmlinux-6.1.128';
const ROOTFS = 'guest.ext4';
const TENANT = 'acme';
const CHROOT_BASE = '/srv/bastion/jail';

/**
 * The tenant's worker.
 *
 * `/kv` is the assertion that matters most: it leaves the guest, crosses vsock to a handler on the
 * host, and comes back. A worker with no bindings cannot tell a guest from a host process.
 */
const WORKER = [
	'export default {',
	'  async fetch(request, env) {',
	'    const url = new URL(request.url);',
	'    if (url.pathname === "/kv") {',
	'      await env.NOTES.put("greeting", "out of the guest and back");',
	'      return new Response(await env.NOTES.get("greeting"));',
	'    }',
	'    return new Response("served from inside the guest", {',
	'      headers: { "x-tenant": "acme" }',
	'    });',
	'  }',
	'};'
].join('\n');

const MANIFEST = JSON.stringify({
	name: 'acme',
	main: 'index.js',
	compatibility_date: '2026-08-01',
	kv_namespaces: [{ binding: 'NOTES', id: 'notes' }]
});

const present = (name: string): { what: string; present: boolean } => ({
	what: `${join(RIG, name)} is absent; core/scripts/guest-image.sh builds it`,
	present: existsSync(join(RIG, name))
});

const reason = gate('REQUIRE_KVM', [
	{ what: '/dev/kvm is absent, so no guest can boot', present: existsSync('/dev/kvm') },
	present('firecracker'),
	present('jailer'),
	present(KERNEL),
	present(ROOTFS)
]);

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

/** the front door routes on Host, so a request without one is a 404 rather than a tenant's page */
const ask = (path: string): Promise<{ code: number; out: string }> =>
	inside(
		`cd /work && bun -e 'const r = await fetch("http://127.0.0.1:8080${path}", ` +
			`{ headers: { host: "www.example.edu" } }); ` +
			`console.log(r.status, r.headers.get("x-tenant"), await r.text());'`
	);

describe.skipIf(reason !== null)('a site served from inside a guest', () => {
	beforeAll(async () => {
		const rig = mkdtempSync(join(tmpdir(), 'bastion-mv-'));
		const work = mkdtempSync(join(tmpdir(), 'bastion-mvwork-'));
		prepared = true;

		const repo = join(import.meta.dirname, '..', '..', '..');
		await run('bun', [
			'build',
			'--compile',
			`--target=${process.arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64'}`,
			'--outfile',
			join(rig, 'bastion'),
			join(repo, 'warden', 'src', 'cli.ts')
		]);

		mkdirSync(join(work, 'bundle'), { recursive: true });
		writeFileSync(join(work, 'bundle', 'index.js'), WORKER);
		writeFileSync(join(work, 'bundle', 'wrangler.jsonc'), MANIFEST);
		writeFileSync(
			join(work, 'bastion.yml'),
			[
				'version: 1',
				'mode: isolated',
				'state: /work/state',
				'listeners:',
				'  http: { address: "127.0.0.1:8080" }',
				'  management: { address: "127.0.0.1:8787" }',
				'runtime:',
				`  guest: { kernel: /fc/${KERNEL}, rootfs: /fc/${ROOTFS}, ` +
					'firecracker: /fc/firecracker, jailer: /fc/jailer }',
				'tenants:',
				'  - name: acme',
				'    limits: { cpu: "1", memory: 1Gi }',
				'    sites:',
				'      - host: www.example.edu',
				'        bundle: /work/bundle',
				'        worker:',
				'          main: index.js',
				'          durableObjectClass: null',
				'          kv: [NOTES]',
				''
			].join('\n')
		);

		// the device because a guest needs kvm, privileged because the jailer builds a chroot and
		// makes device nodes in it, and the rig read-only because nothing here writes to it
		await run('docker', [
			'run',
			'--rm',
			'-d',
			'--name',
			NAME,
			'--privileged',
			'--cgroupns=host',
			'--device',
			'/dev/kvm',
			'-v',
			`${rig}:/rig`,
			'-v',
			`${work}:/work`,
			'-v',
			`${RIG}:/fc:ro`,
			'-w',
			'/work',
			IMAGE,
			'sleep',
			'1800'
		]);

		// mkfs.ext4 builds the per-tenant config drive; the base image has truncate but not this
		const staged = await inside(
			'apt-get update >/dev/null 2>&1 && apt-get install -y e2fsprogs >/dev/null 2>&1 && ' +
				'command -v mkfs.ext4 && echo staged'
		);
		if (!staged.out.includes('staged')) {
			throw new Error(`could not install e2fsprogs in the container: ${staged.out}`);
		}
	}, 900_000);

	afterAll(async () => {
		if (!prepared) return;
		await run('docker', [
			'exec',
			NAME,
			'sh',
			'-c',
			'cd /work && /rig/bastion down || true'
		]).catch(() => undefined);
		await run('docker', ['rm', '-f', NAME]).catch(() => undefined);
	});

	it('reports isolated as available on a host that has kvm', async () => {
		const answer = await bastion('doctor');
		expect(answer.out).toContain('platform             linux');
		expect(answer.out).toMatch(/mode available here\s+yes/);
	});

	/** the https listener refuses to bind without one, and would serve cleartext if it did not */
	it('self-signs a certificate', async () => {
		expect((await bastion('cert self-sign www.example.edu')).code).toBe(0);
	});

	it('brings the box up, which boots one guest per tenant', async () => {
		const answer = await bastion('up');
		expect(answer.out).not.toContain('will not run a weaker mode');
		expect(answer.code).toBe(0);
		// the guest boots, mounts two drives and starts workerd before it can answer
		await new Promise((resolve) => setTimeout(resolve, 12_000));
	}, 120_000);

	it('lists the guest from a second process, reading what serve recorded', async () => {
		const answer = await bastion('vm list');
		expect(answer.out).toContain('acme');
		expect(answer.out).not.toContain('no guests are running');
	});

	/** the request crosses vsock, because there is no socket on the host to dial */
	it('serves a request from workerd inside the guest', async () => {
		const answer = await ask('/');
		expect(answer.out).toContain('200');
		expect(answer.out).toContain('served from inside the guest');
		expect(answer.out).toContain('acme');
	}, 60_000);

	/** out of the guest, onto a handler bastion bound on the host side of the same vsock */
	it('answers an adapter call that left the guest and came back', async () => {
		const answer = await ask('/kv');
		expect(answer.out).toContain('200');
		expect(answer.out).toContain('out of the guest and back');
	}, 60_000);

	it('runs no workerd on the host, because the tenant is not there', async () => {
		const answer = await inside(
			'n=0; for e in /proc/[0-9]*/exe; do case "$(readlink $e 2>/dev/null)" in ' +
				'*workerd*) n=$((n+1));; esac; done; echo count=$n'
		);
		expect(answer.out).toContain('count=0');
	});

	it('runs a firecracker for the tenant instead', async () => {
		const answer = await inside(
			'n=0; for e in /proc/[0-9]*/exe; do case "$(readlink $e 2>/dev/null)" in ' +
				'*firecracker*) n=$((n+1));; esac; done; echo count=$n'
		);
		expect(answer.out).not.toContain('count=0');
	});

	it('boots on real KVM rather than emulating a machine', async () => {
		const console_ = await inside('cat /var/log/bastion/guests/acme.log');
		expect(console_.out).toContain('Hypervisor detected: KVM');
	});

	/** a guest that fails to boot says why on ttyS0 and nowhere else */
	it('writes the guest console somewhere an operator can read it', async () => {
		const console_ = await inside('cat /var/log/bastion/guests/acme.log');
		expect(console_.out).toContain('Run /sbin/init');
		expect(console_.out).not.toContain('Kernel panic');
	});

	it('gives the guest no network interface, so egress is absent rather than filtered', async () => {
		const console_ = await inside('cat /var/log/bastion/guests/acme.log');
		expect(console_.out).not.toMatch(/virtio_net|eth0/);
	});

	/**
	 * The jailer canonicalizes `--exec-file` and names the chroot after what it resolves to, so
	 * this is also the assertion that bastion followed the same resolution. Computing from the
	 * configured path put the guest's files in a directory the jailer never built, and firecracker
	 * aborted on a configuration file it could not open.
	 */
	it('placed every file the guest boots from in the chroot the jailer built', async () => {
		const resolved = (await inside('readlink -f /fc/firecracker')).out.trim();
		const chroot = chrootFor(TENANT, resolved, CHROOT_BASE);
		const listed = await inside(`ls ${chroot}`);
		for (const path of [GUEST_PATHS.kernel, GUEST_PATHS.rootfs, GUEST_PATHS.state]) {
			expect(listed.out).toContain(path.slice(1));
		}
		// the jailer copies the VMM in beside them, so this is the directory it chrooted into
		expect(listed.out).toContain('.pid');
	});

	it('leaves the chroot readable only by the uid the guest runs as', async () => {
		const resolved = (await inside('readlink -f /fc/firecracker')).out.trim();
		const mode = await inside(`stat -c %a ${chrootFor(TENANT, resolved, CHROOT_BASE)}`);
		expect(mode.out.trim()).toBe(String(CHROOT_MODE.toString(8)));
	});
});
