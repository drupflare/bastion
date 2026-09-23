import type { Context } from '../context';
import { BastionError } from '../errors';
import type { Guest, GuestSpec, Hypervisor } from './hypervisor';

export const JAILER_CHROOT_BASE = '/srv/bastion/jail';
export const CHROOT_MODE = 0o700;

/**
 * What each of the guest's files is called once it is inside the chroot.
 *
 * The jailer chroots before firecracker opens anything, so a host path in the config resolves to
 * nothing: every file the guest boots from has to be placed in the chroot and named relative to
 * it. The driver wrote absolute host paths and placed nothing, so a guest could not boot at all.
 */
export const GUEST_PATHS = {
	kernel: '/vmlinux',
	rootfs: '/rootfs.ext4',
	state: '/state.ext4',
	config: '/config.capnp',
	vsock: '/bastion.vsock'
} as const;

/**
 * Where the jailer puts this guest's chroot.
 *
 * The exec file's own name is a path component the jailer inserts, so `--chroot-base-dir /b` with
 * `--exec-file /x/firecracker` and `--id bastion-acme` lands at `/b/firecracker/bastion-acme/root`
 * and not at `/b/bastion-acme/root`. The jailer canonicalizes that path first, so the caller
 * passes an already-resolved one: a pinned binary reached through a stable symlink otherwise names
 * a chroot the jailer never builds.
 */
export function chrootFor(tenant: string, firecracker: string, chrootBase: string): string {
	const exec = firecracker.split('/').filter((part) => part !== '');
	return `${chrootBase}/${exec[exec.length - 1] ?? 'firecracker'}/bastion-${tenant}/root`;
}

/**
 * Flags bastion never passes to firecracker.
 *
 * `--enable-pci` closes CVE-2026-5747 structurally rather than by staying patched: the bug is a
 * root guest rewriting `queue_size` after activation in virtio-PCI, writing up to 524,284 bytes
 * out of bounds, and the default MMIO transport is unaffected. The `>= 1.15.1` floor still applies
 * underneath, but an argument bastion does not construct cannot be reached by a regression.
 */
export const FORBIDDEN_VMM_FLAGS = ['--enable-pci'] as const;

export interface FirecrackerConfig {
	'boot-source': { kernel_image_path: string; boot_args: string };
	drives: {
		drive_id: string;
		path_on_host: string;
		is_root_device: boolean;
		is_read_only: boolean;
	}[];
	'machine-config': { vcpu_count: number; mem_size_mib: number; smt: boolean };
	vsock: { guest_cid: number; uds_path: string };
}

/**
 * The guest configuration, with no network interface at all.
 *
 * Adapter traffic crosses on vsock, so the guest has no NIC to route out of and egress is denied
 * by the absence of a device rather than by a rule that could be wrong. `boot_args` carries
 * `panic=1 reboot=k` so a guest that panics dies and is restarted by the supervisor instead of
 * sitting at a rescue prompt forever.
 */
export function firecrackerConfig(spec: GuestSpec): FirecrackerConfig {
	return {
		'boot-source': {
			kernel_image_path: GUEST_PATHS.kernel,
			boot_args: 'console=ttyS0 reboot=k panic=1 pci=off i8042.noaux i8042.nomux'
		},
		drives: [
			{
				drive_id: 'rootfs',
				path_on_host: GUEST_PATHS.rootfs,
				is_root_device: true,
				is_read_only: true
			},
			{
				drive_id: 'state',
				path_on_host: GUEST_PATHS.state,
				is_root_device: false,
				is_read_only: false
			},
			{
				drive_id: 'config',
				path_on_host: GUEST_PATHS.config,
				is_root_device: false,
				is_read_only: true
			}
		],
		'machine-config': { vcpu_count: spec.vcpus, mem_size_mib: spec.memoryMib, smt: false },
		vsock: { guest_cid: spec.guestCid, uds_path: GUEST_PATHS.vsock }
	};
}

export function jailerArgv(
	spec: GuestSpec,
	options: { uid: number; gid: number; firecracker: string; chrootBase?: string }
): string[] {
	return [
		'--id',
		`bastion-${spec.tenant}`,
		'--exec-file',
		options.firecracker,
		'--uid',
		String(options.uid),
		'--gid',
		String(options.gid),
		'--chroot-base-dir',
		options.chrootBase ?? JAILER_CHROOT_BASE,
		'--',
		'--config-file',
		'config.json',
		'--no-api'
	];
}

export function assertVmmArgvSafe(args: string[]): void {
	for (const flag of FORBIDDEN_VMM_FLAGS) {
		if (args.includes(flag)) {
			throw new BastionError(
				'capability-refused',
				`${flag} is never passed: it opens the virtio-PCI transport CVE-2026-5747 reaches ` +
					'through, and the default MMIO transport is unaffected'
			);
		}
	}
}

export interface FirecrackerOptions {
	firecracker?: string;
	jailer?: string;
	uid?: number;
	gid?: number;
	chrootBase?: string;
	/**
	 * Where each guest's serial console is written.
	 *
	 * A guest that fails to boot says why on `ttyS0` and nowhere else, so discarding it leaves an
	 * operator with a tenant that is down and no way to find out why.
	 */
	consoleDir?: string;
	/** a seam so the gate lane drives both branches of the platform refusal */
	platform?: string;
}

export const CONSOLE_DIR = '/var/log/bastion/guests';

/**
 * Firecracker, through the jailer.
 *
 * The chroot is created FRESH at 0700 per boot, which is the class CVE-2026-1386 (jailer symlink
 * following) lives in: a directory left behind from a previous boot is a directory something else
 * may have prepared. Each tenant's capnp is copied in readable by that guest alone, because
 * bindings are secrets and a shared config file is every tenant's credentials at once.
 */
export function firecrackerHypervisor(options: FirecrackerOptions = {}): Hypervisor {
	const guests = new Map<string, Guest>();
	const firecracker = options.firecracker ?? '/usr/bin/firecracker';
	const jailer = options.jailer ?? '/usr/bin/jailer';
	const chrootBase = options.chrootBase ?? JAILER_CHROOT_BASE;

	return {
		id: () => 'firecracker',

		chrootFor: (ctx: Context, tenant: string) =>
			chrootFor(tenant, ctx.files.realpath(firecracker), chrootBase),

		unavailableReason: (ctx: Context) => {
			if ((options.platform ?? process.platform) !== 'linux') {
				return 'microVMs need linux; this host is not';
			}
			if (!ctx.files.exists('/dev/kvm'))
				return '/dev/kvm is absent, so no guest can be booted';
			if (!ctx.files.exists(jailer)) return `${jailer} is absent`;
			return null;
		},

		create: async (ctx, spec) => {
			const reason = firecrackerHypervisor(options).unavailableReason(ctx);
			if (reason !== null) throw new BastionError('preflight-unsupported', reason);

			const uid = options.uid ?? 1000;
			const gid = options.gid ?? 1000;
			const exec = ctx.files.realpath(firecracker);
			const chroot = chrootFor(spec.tenant, exec, chrootBase);
			if (ctx.files.exists(chroot)) {
				// a chroot left from a previous boot is a directory something else may have prepared
				ctx.files.remove(`${chroot}/config.json`);
			}
			ctx.files.mkdirp(chroot);
			ctx.files.chmod(chroot, CHROOT_MODE);
			ctx.files.chown(chroot, uid, gid);

			// the guest boots from inside the chroot, so every file it opens is placed there first
			// and the state drive is handed to the uid the jailer drops firecracker to
			for (const [source, guestPath, mode] of [
				[spec.kernel, GUEST_PATHS.kernel, 0o400],
				[spec.rootfs, GUEST_PATHS.rootfs, 0o400],
				[spec.state, GUEST_PATHS.state, 0o600],
				[spec.config, GUEST_PATHS.config, 0o400]
			] as const) {
				const placed = `${chroot}${guestPath}`;
				ctx.files.link(source, placed);
				ctx.files.chmod(placed, mode);
				ctx.files.chown(placed, uid, gid);
			}

			ctx.files.writeText(
				`${chroot}/config.json`,
				JSON.stringify(firecrackerConfig(spec), null, 2)
			);
			ctx.files.chmod(`${chroot}/config.json`, 0o600);
			ctx.files.chown(`${chroot}/config.json`, uid, gid);

			const args = jailerArgv(spec, { uid, gid, firecracker: exec, chrootBase });
			assertVmmArgvSafe(args);
			const console = `${options.consoleDir ?? CONSOLE_DIR}/${spec.tenant}.log`;
			const started = ctx.runner.spawn(jailer, args, { logFile: console });
			const guest: Guest = {
				tenant: spec.tenant,
				state: 'running',
				pid: started.pid,
				chroot,
				vsock: `${chroot}${GUEST_PATHS.vsock}`,
				console
			};
			guests.set(spec.tenant, guest);
			return guest;
		},

		stop: async (ctx, tenant) => {
			const guest = guests.get(tenant);
			if (guest === undefined) return;
			if (guest.pid !== null) ctx.runner.signal(guest.pid, 'SIGTERM');
			guests.set(tenant, { ...guest, state: 'stopped', pid: null });
		},

		list: () => [...guests.values()]
	};
}
