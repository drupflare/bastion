import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { scriptedRunner } from '../../../src/host/exec';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import {
	assertVmmArgvSafe,
	CHROOT_MODE,
	chrootFor,
	firecrackerConfig,
	firecrackerHypervisor,
	FORBIDDEN_VMM_FLAGS,
	GUEST_PATHS,
	jailerArgv
} from '../../../src/isolation/firecracker';
import type { GuestSpec } from '../../../src/isolation/hypervisor';

const spec: GuestSpec = {
	tenant: 'acme',
	vcpus: 2,
	memoryMib: 4096,
	kernel: '/srv/bastion/vmlinux',
	rootfs: '/srv/bastion/rootfs.ext4',
	config: '/var/lib/bastion/tenants/acme/config.capnp',
	state: '/var/lib/bastion/tenants/acme/state.ext4',
	vsockUds: '/run/bastion/acme.vsock',
	guestCid: 3
};

function harness(seed: Record<string, string> = {}) {
	const files = memoryFiles({
		'/dev/kvm': '',
		'/usr/bin/jailer': '',
		[spec.kernel]: 'vmlinux',
		[spec.rootfs]: 'rootfs',
		[spec.state]: 'state',
		[spec.config]: 'capnp',
		...seed
	});
	const runner = scriptedRunner();
	return {
		ctx: { ...defaultContext(), files, runner, io: memoryIo(), env: {}, now: () => 0 },
		files,
		runner
	};
}

describe('firecrackerConfig', () => {
	it('gives the guest no network interface at all', () => {
		expect(Object.keys(firecrackerConfig(spec))).not.toContain('network-interfaces');
	});

	it('crosses adapter traffic on vsock, so the guest opens no socket bastion did not give it', () => {
		expect(firecrackerConfig(spec).vsock).toEqual({
			guest_cid: 3,
			uds_path: GUEST_PATHS.vsock
		});
	});

	/**
	 * The config is read by firecracker AFTER the jailer has chrooted, so a host path in it names
	 * nothing. The driver emitted host paths and placed no files, so every guest it started died
	 * on `Unable to open or read from the configuration file`.
	 */
	it('names every file where the guest will find it rather than where the host holds it', () => {
		const config = firecrackerConfig(spec);
		expect(config['boot-source'].kernel_image_path).toBe(GUEST_PATHS.kernel);
		expect(config.drives.map((drive) => drive.path_on_host)).toEqual([
			GUEST_PATHS.rootfs,
			GUEST_PATHS.state,
			GUEST_PATHS.config
		]);
		for (const path of Object.values(GUEST_PATHS)) expect(path.startsWith('/')).toBe(true);
	});

	it('mounts the root filesystem read only and the state writable', () => {
		const drives = firecrackerConfig(spec).drives;
		expect(drives.find((d) => d.drive_id === 'rootfs')?.is_read_only).toBe(true);
		expect(drives.find((d) => d.drive_id === 'state')?.is_read_only).toBe(false);
	});

	it('mounts the tenant capnp read only, because bindings are secrets', () => {
		expect(
			firecrackerConfig(spec).drives.find((d) => d.drive_id === 'config')?.is_read_only
		).toBe(true);
	});

	it('dies on a panic rather than sitting at a prompt', () => {
		expect(firecrackerConfig(spec)['boot-source'].boot_args).toContain('panic=1');
	});

	it('turns SMT off, so two tenants never share a physical core', () => {
		expect(firecrackerConfig(spec)['machine-config'].smt).toBe(false);
	});
});

describe('the forbidden flags', () => {
	it('never constructs --enable-pci', () => {
		const args = jailerArgv(spec, { uid: 1, gid: 1, firecracker: '/usr/bin/firecracker' });
		for (const flag of FORBIDDEN_VMM_FLAGS) expect(args).not.toContain(flag);
	});

	it('refuses an argv carrying one, naming the CVE it closes', () => {
		expect(() => assertVmmArgvSafe(['--enable-pci'])).toThrow(/CVE-2026-5747/);
	});

	it('accepts an argv without one', () => {
		expect(() => assertVmmArgvSafe(['--config-file', 'config.json'])).not.toThrow();
	});
});

describe('firecrackerHypervisor', () => {
	it('refuses by name without /dev/kvm rather than falling back to a weaker mode', () => {
		const files = memoryFiles({ '/usr/bin/jailer': '' });
		const ctx = { ...defaultContext(), files, io: memoryIo(), env: {}, now: () => 0 };
		expect(firecrackerHypervisor({ platform: 'linux' }).unavailableReason(ctx)).toContain(
			'/dev/kvm'
		);
	});

	it('refuses by name without the jailer', () => {
		const files = memoryFiles({ '/dev/kvm': '' });
		const ctx = { ...defaultContext(), files, io: memoryIo(), env: {}, now: () => 0 };
		expect(firecrackerHypervisor({ platform: 'linux' }).unavailableReason(ctx)).toContain(
			'jailer'
		);
	});

	it('creates the chroot at 0700', async () => {
		const { ctx, files } = harness();
		const guest = await firecrackerHypervisor({ platform: 'linux' }).create(ctx, spec);
		expect(files.mode(guest.chroot)).toBe(CHROOT_MODE);
	});

	it('writes the guest config readable by nobody else', async () => {
		const { ctx, files } = harness();
		const guest = await firecrackerHypervisor({ platform: 'linux' }).create(ctx, spec);
		expect(files.mode(`${guest.chroot}/config.json`)).toBe(0o600);
	});

	it('spawns the jailer rather than firecracker directly', async () => {
		const { ctx, runner } = harness();
		await firecrackerHypervisor({ platform: 'linux' }).create(ctx, spec);
		expect(runner.calls[0]?.command).toBe('/usr/bin/jailer');
		expect(runner.calls[0]?.mode).toBe('spawn');
	});

	/**
	 * The jailer inserts the exec file's own name, so a chroot computed without it is a directory
	 * the jailer never looks in. bastion wrote the config to one and firecracker aborted.
	 */
	it('puts the chroot where the jailer will actually look for it', () => {
		expect(chrootFor('acme', '/usr/bin/firecracker', '/srv/bastion/jail')).toBe(
			'/srv/bastion/jail/firecracker/bastion-acme/root'
		);
	});

	/**
	 * A pinned binary is normally reached through a stable symlink, and the jailer canonicalizes
	 * `--exec-file` before naming the chroot after it. Computing from the configured path put the
	 * guest's files in a directory the jailer never built.
	 */
	it('follows a symlinked firecracker to the name the jailer will use', async () => {
		const { ctx, files, runner } = harness({ '/opt/fc/firecracker-1.17.0': '' });
		const resolved = '/opt/fc/firecracker-1.17.0';
		ctx.files = { ...files, realpath: (path) => (path === '/rig/fc' ? resolved : path) };
		const guest = await firecrackerHypervisor({
			platform: 'linux',
			firecracker: '/rig/fc'
		}).create(ctx, spec);
		expect(guest.chroot).toBe(chrootFor('acme', resolved, '/srv/bastion/jail'));
		expect(runner.calls[0]?.args).toContain(resolved);
	});

	it('places every file the guest boots from inside the chroot', async () => {
		const { ctx, files } = harness();
		const guest = await firecrackerHypervisor({ platform: 'linux' }).create(ctx, spec);
		expect(files.readText(`${guest.chroot}${GUEST_PATHS.kernel}`)).toBe('vmlinux');
		expect(files.readText(`${guest.chroot}${GUEST_PATHS.rootfs}`)).toBe('rootfs');
		expect(files.readText(`${guest.chroot}${GUEST_PATHS.state}`)).toBe('state');
		expect(files.readText(`${guest.chroot}${GUEST_PATHS.config}`)).toBe('capnp');
	});

	/** the jailer drops firecracker to this uid, so a state drive it cannot write is a dead guest */
	it('hands the state drive to the uid the jailer drops to, and keeps the rest read only', async () => {
		const { ctx, files } = harness();
		const guest = await firecrackerHypervisor({ platform: 'linux', uid: 700, gid: 700 }).create(
			ctx,
			spec
		);
		expect(files.owner(`${guest.chroot}${GUEST_PATHS.state}`)).toEqual({ uid: 700, gid: 700 });
		expect(files.mode(`${guest.chroot}${GUEST_PATHS.state}`)).toBe(0o600);
		expect(files.mode(`${guest.chroot}${GUEST_PATHS.config}`)).toBe(0o400);
	});

	it('reports the host side of the vsock socket, which the jailer put in the chroot', async () => {
		const { ctx } = harness();
		const guest = await firecrackerHypervisor({ platform: 'linux' }).create(ctx, spec);
		expect(guest.vsock).toBe(`${guest.chroot}${GUEST_PATHS.vsock}`);
	});

	it('refuses on a host that is not linux, whatever else is present', () => {
		const { ctx } = harness();
		expect(firecrackerHypervisor({ platform: 'darwin' }).unavailableReason(ctx)).toContain(
			'linux'
		);
	});

	it('refuses to create on a host that cannot run guests', async () => {
		const files = memoryFiles();
		const ctx = { ...defaultContext(), files, io: memoryIo(), env: {}, now: () => 0 };
		await expect(
			firecrackerHypervisor({ platform: 'linux' }).create(ctx, spec)
		).rejects.toThrow();
	});
});
