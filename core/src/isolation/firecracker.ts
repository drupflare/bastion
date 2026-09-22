import type { Context } from '../context';
import { BastionError } from '../errors';
import type { Guest, GuestSpec, Hypervisor } from './hypervisor';

export const JAILER_CHROOT_BASE = '/srv/bastion/jail';
export const CHROOT_MODE = 0o700;

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
			kernel_image_path: spec.kernel,
			boot_args: 'console=ttyS0 reboot=k panic=1 pci=off i8042.noaux i8042.nomux'
		},
		drives: [
			{
				drive_id: 'rootfs',
				path_on_host: spec.rootfs,
				is_root_device: true,
				is_read_only: true
			},
			{
				drive_id: 'state',
				path_on_host: spec.state,
				is_root_device: false,
				is_read_only: false
			},
			{
				drive_id: 'config',
				path_on_host: spec.config,
				is_root_device: false,
				is_read_only: true
			}
		],
		'machine-config': { vcpu_count: spec.vcpus, mem_size_mib: spec.memoryMib, smt: false },
		vsock: { guest_cid: spec.guestCid, uds_path: spec.vsockUds }
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
	/** a seam so the gate lane drives both branches of the platform refusal */
	platform?: string;
}

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

			const chroot = `${chrootBase}/bastion-${spec.tenant}/root`;
			if (ctx.files.exists(chroot)) {
				// a chroot left from a previous boot is a directory something else may have prepared
				ctx.files.remove(`${chroot}/config.json`);
			}
			ctx.files.mkdirp(chroot);
			ctx.files.chmod(chroot, CHROOT_MODE);
			ctx.files.writeText(
				`${chroot}/config.json`,
				JSON.stringify(firecrackerConfig(spec), null, 2)
			);
			ctx.files.chmod(`${chroot}/config.json`, 0o600);

			const args = jailerArgv(spec, {
				uid: options.uid ?? 1000,
				gid: options.gid ?? 1000,
				firecracker,
				chrootBase
			});
			assertVmmArgvSafe(args);
			const started = ctx.runner.spawn(jailer, args);
			const guest: Guest = {
				tenant: spec.tenant,
				state: 'running',
				pid: started.pid,
				chroot
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
