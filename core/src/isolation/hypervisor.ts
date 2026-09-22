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
	create(ctx: Context, spec: GuestSpec): Promise<Guest>;
	stop(ctx: Context, tenant: string): Promise<void>;
	list(): Guest[];
}
