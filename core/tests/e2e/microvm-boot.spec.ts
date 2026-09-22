import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '../../src/context';
import { memoryIo } from '../../src/io';
import { chrootFor, firecrackerHypervisor, GUEST_PATHS } from '../../src/isolation/firecracker';
import type { Guest } from '../../src/isolation/hypervisor';
import { preflight } from '../../src/isolation/preflight';
import { containerFiles, containerRunner } from './support/container';
import { gate } from './support/gate';

/**
 * `isolated` mode, booting a real guest on real KVM.
 *
 * Everything here needs a hypervisor to be true at all, which is why none of it could be asserted
 * before: the driver's argv and its refusals were unit-tested and its chroot had never held a
 * guest. The first real boot found three defects that made every guest die on startup, each of
 * the "built and read by nobody" class -- the chroot was computed without the path component the
 * jailer inserts, nothing placed the kernel or the root filesystem inside it, and the serial
 * console was discarded, so a guest that failed said why to nothing.
 *
 * `create()` does the whole job here. A spec that placed the files itself and then ran the jailer
 * by hand would assert that firecracker works, which was never in doubt.
 */
const run = promisify(execFile);

const MARKER = 'BASTION_GUEST_UP';
const RIG = process.env.BASTION_KVM_RIG ?? join(process.env.HOME ?? '', 'bastion-rig', 'fc');
const IMAGE = 'alpine:3.21';
const NAME = `bastion-kvm-${process.pid}`;
const TENANT = 'acme';
const CHROOT_BASE = '/srv/bastion/jail';
const KERNEL = 'vmlinux-6.1.128';
const ROOTFS = 'guest.ext4';

const present = (name: string): { what: string; present: boolean } => ({
	what: `${join(RIG, name)} is absent; the microVM rig builds it`,
	present: existsSync(join(RIG, name))
});

const reason = gate('REQUIRE_KVM', [
	{ what: '/dev/kvm is absent, so no guest can boot', present: existsSync('/dev/kvm') },
	present('firecracker'),
	present('jailer'),
	present(KERNEL),
	present(ROOTFS)
]);

let console_ = '';
let guest: Guest | null = null;

const inside = async (script: string): Promise<string> => {
	const { stdout, stderr } = await run('docker', ['exec', NAME, 'sh', '-c', script], {
		maxBuffer: 32 * 1024 * 1024
	});
	return `${stdout}${stderr}`;
};

describe.skipIf(reason !== null)('a tenant in its own microVM', () => {
	beforeAll(async () => {
		// privileged because the jailer builds a chroot and makes device nodes in it, and the
		// device because a guest without /dev/kvm is emulation rather than the mode under test
		await run('docker', [
			'run',
			'-d',
			'--name',
			NAME,
			'--privileged',
			'--device',
			'/dev/kvm',
			'-v',
			`${RIG}:/rig:ro`,
			IMAGE,
			'sleep',
			'600'
		]);

		const ctx = {
			...defaultContext(),
			io: memoryIo(),
			platform: 'linux',
			files: containerFiles(NAME),
			runner: containerRunner(NAME)
		};

		// the tenant's Durable Object storage and its capnp, as block devices the guest can open;
		// neither needs contents for a boot, and both are outside the read-only rig mount
		await inside('dd if=/dev/zero of=/state.ext4 bs=1M count=8 2>/dev/null');
		await inside('dd if=/dev/zero of=/config.img bs=1M count=1 2>/dev/null');

		const consoleDir = mkdtempSync(join(tmpdir(), 'bastion-kvm-'));
		guest = await firecrackerHypervisor({
			platform: 'linux',
			firecracker: '/rig/firecracker',
			jailer: '/rig/jailer',
			uid: 0,
			gid: 0,
			chrootBase: CHROOT_BASE,
			consoleDir
		}).create(ctx, {
			tenant: TENANT,
			vcpus: 1,
			memoryMib: 256,
			kernel: `/rig/${KERNEL}`,
			rootfs: `/rig/${ROOTFS}`,
			state: '/state.ext4',
			config: '/config.img',
			vsockUds: '/run/bastion/acme.vsock',
			guestCid: 3
		});

		// the guest's own init prints the marker and powers off, so this waits for the VM to end
		// rather than sleeping a fixed time and hoping
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			console_ = existsSync(guest.console) ? readFileSync(guest.console, 'utf8') : '';
			if (console_.includes('Firecracker exiting') || console_.includes('panicked')) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}, 180_000);

	afterAll(async () => {
		await run('docker', ['rm', '-f', NAME]).catch(() => undefined);
	});

	it('writes the guest console somewhere an operator can read it', () => {
		expect(guest?.console).toBeTruthy();
		expect(console_).not.toBe('');
	});

	it('boots on real KVM rather than emulating a machine', () => {
		expect(console_).toContain('Hypervisor detected: KVM');
	});

	it('reaches userspace, which is the claim the mode table makes for isolated', () => {
		expect(console_).toContain(MARKER);
	});

	/**
	 * The rig reaches firecracker through a symlink, which is how a pinned binary is normally
	 * installed. The jailer canonicalizes it and names the chroot after what it resolves to, so
	 * this is also the assertion that the driver followed the link rather than the path it was
	 * given -- computing from the configured path put the guest's files somewhere nothing looked.
	 */
	it('puts the chroot where the jailer actually built it, symlink resolved', async () => {
		const resolved = (await inside('readlink -f /rig/firecracker')).trim();
		expect(guest?.chroot).toBe(chrootFor(TENANT, resolved, CHROOT_BASE));
		// the jailer copies the VMM in beside the files bastion placed, so this directory is the
		// one it chrooted into rather than one that merely has the right name
		expect(await inside(`ls ${guest?.chroot ?? ''}`)).toContain('.pid');
		expect(console_).not.toContain('Unable to open or read from the configuration file');
	});

	it('placed every file the guest boots from inside the chroot', async () => {
		const listed = await inside(`ls ${guest?.chroot ?? ''}`);
		for (const path of [GUEST_PATHS.kernel, GUEST_PATHS.rootfs, GUEST_PATHS.state]) {
			expect(listed).toContain(path.slice(1));
		}
	});

	it('gives the guest no network interface, so egress is absent rather than filtered', () => {
		expect(console_).not.toMatch(/virtio_net|eth0/);
	});

	it('shuts down cleanly when the guest powers itself off', () => {
		expect(console_).toContain('Firecracker exiting successfully');
	});

	it('probes KVM off the host rather than inferring it from the platform name', () => {
		const ctx = {
			...defaultContext(),
			io: memoryIo(),
			platform: 'linux',
			files: containerFiles(NAME),
			runner: containerRunner(NAME),
			env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }
		};
		expect(preflight(ctx, 'linux').mechanisms.find((m) => m.id === 'kvm')).toMatchObject({
			present: true,
			source: 'probed'
		});
	});
});
