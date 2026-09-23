import type { Context } from '../context';

export interface GuestSpec {
	tenant: string;
	vcpus: number;
	memoryMib: number;
	/** the guest kernel and the root filesystem carrying workerd */
	kernel: string;
	rootfs: string;
	/** the tenant's generated capnp, readable by this guest alone */
	config: string;
	/** the tenant's Durable Object storage, passed as its own block device */
	state: string;
	/** the host socket adapter traffic crosses on, so the guest opens nothing bastion did not give it */
	vsockUds: string;
	guestCid: number;
}

export type GuestState = 'stopped' | 'booting' | 'running' | 'failed';

export interface Guest {
	tenant: string;
	state: GuestState;
	pid: number | null;
	/** where the jailer put this guest's chroot */
	chroot: string;
	/** the host side of the vsock socket, which the jailer places inside the chroot */
	vsock: string;
	/** where this guest's serial console is written; the only place a failed boot says why */
	console: string;
}

/**
 * One microVM per tenant.
 *
 * A contract rather than a direct Firecracker call because the roadmap names Cloud Hypervisor as a
 * second option; the second driver is NOT built, because an abstraction drawn against zero
 * implementations is the thing this project refuses. The seam exists at all so the supervisor and
 * the gate lane do not import a hypervisor.
 */
export interface Hypervisor {
	id(): string;
	/** why this host cannot run guests, or null */
	unavailableReason(ctx: Context): string | null;
	/**
	 * Where this tenant's guest WILL live, before one is created.
	 *
	 * The adapter sockets have to be bound before the guest boots, and their host paths are
	 * derived from the chroot, so the answer cannot wait for `create` to return it.
	 */
	chrootFor(ctx: Context, tenant: string): string;
	create(ctx: Context, spec: GuestSpec): Promise<Guest>;
	stop(ctx: Context, tenant: string): Promise<void>;
	list(): Guest[];
}
