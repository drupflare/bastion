import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { scriptedRunner } from '../../../src/host/exec';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import {
	assertVmmArgvSafe,
	CHROOT_MODE,
	firecrackerConfig,
	firecrackerHypervisor,
	FORBIDDEN_VMM_FLAGS,
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
	const files = memoryFiles({ '/dev/kvm': '', '/usr/bin/jailer': '', ...seed });
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
		expect(firecrackerConfig(spec).vsock).toEqual({ guest_cid: 3, uds_path: spec.vsockUds });
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
