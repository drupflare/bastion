import type { TenantPaths } from '../capnp/plan';
import type { Context } from '../context';
import { BastionError } from '../errors';
import { VSOCK_PORTS } from './vsock';

/**
 * Where a tenant's files are once they are inside its guest.
 *
 * Fixed rather than configured, because both halves have to agree and only one of them is written
 * here: bastion generates the capnp against these paths and the guest image's init mounts to them.
 * A configurable layout is two places to change and one of them lives in somebody else's rootfs.
 */
export const GUEST_LAYOUT = {
	/** the config drive, read only: the capnp, the bundle and the site's assets */
	config: '/srv/bastion',
	/** the state drive, writable: workerd's on-disk Durable Object storage */
	storage: '/var/lib/bastion/storage',
	/** where the guest's forwarders bind, one socket per adapter */
	adapters: '/run/bastion/adapters',
	/** workerd's own listener; the serve forwarder connects here */
	listen: '/run/bastion/http.sock'
} as const;

/** the capnp paths for a tenant that runs in a guest rather than on the host */
export function guestPaths(): TenantPaths {
	return {
		bundle: `${GUEST_LAYOUT.config}/bundle`,
		storage: GUEST_LAYOUT.storage,
		assets: `${GUEST_LAYOUT.config}/assets`,
		adapterDir: GUEST_LAYOUT.adapters,
		listenSocket: GUEST_LAYOUT.listen
	};
}

/**
 * Every adapter socket, named on the host side rather than the guest side.
 *
 * The guest dials a vsock port and firecracker turns that into a connection to `<uds>_<port>` on
 * the host, so bastion binds the same HTTP handler it always did, at a different path.
 */
export function adapterVsockPath(vsockUds: string, slot: string): string | null {
	const port = (VSOCK_PORTS as Record<string, number | undefined>)[slot];
	return port === undefined ? null : `${vsockUds}_${port}`;
}

const MKFS = 'mkfs.ext4';

/**
 * Builds one read-only drive out of a directory.
 *
 * `mkfs.ext4 -d` rather than a loop mount, because populating an image that way needs root and a
 * mount namespace, and bastion is trying to avoid holding either longer than the jailer does.
 */
export async function buildImage(
	ctx: Context,
	staging: string,
	image: string,
	sizeMib: number
): Promise<void> {
	ctx.files.remove(image);
	const truncate = await ctx.runner.run('truncate', ['-s', `${sizeMib}M`, image]);
	if (truncate.code !== 0) {
		throw new BastionError('driver-unreachable', `could not size ${image}: ${truncate.stderr}`);
	}
	const made = await ctx.runner.run(MKFS, ['-q', '-F', '-d', staging, image]);
	if (made.code !== 0) {
		throw new BastionError(
			'driver-unreachable',
			`${MKFS} could not build ${image}: ${made.stderr.trim() || made.stdout.trim()}`,
			{ next: 'bastion doctor' }
		);
	}
}

/** the writable drive, formatted once and kept across restarts because it holds the site */
export async function ensureStateImage(
	ctx: Context,
	image: string,
	sizeMib: number
): Promise<void> {
	if (ctx.files.exists(image)) return;
	const truncate = await ctx.runner.run('truncate', ['-s', `${sizeMib}M`, image]);
	if (truncate.code !== 0) {
		throw new BastionError('driver-unreachable', `could not size ${image}: ${truncate.stderr}`);
	}
	const made = await ctx.runner.run(MKFS, ['-q', '-F', image]);
	if (made.code !== 0) {
		throw new BastionError('driver-unreachable', `${MKFS} could not build ${image}`);
	}
}

/** what a guest boots from, recorded so `vm list` in another process can read it */
export interface GuestRecord {
	tenant: string;
	pid: number | null;
	chroot: string;
	vsock: string;
	console: string;
	startedAt: number;
}

export const GUESTS_FILE = 'guests.json';

/**
 * Guests on disk, because `vm list` runs in a different process from `serve`.
 *
 * The hypervisor keeps its own map, and that map belongs to whichever object created the guest. A
 * CLI that builds a fresh hypervisor to answer `vm list` reads an empty one every time, which is
 * how the command reported no guests on a box that was running them.
 */
export function readGuests(ctx: Context, state: string): GuestRecord[] {
	const path = `${state}/${GUESTS_FILE}`;
	if (!ctx.files.exists(path)) return [];
	try {
		const held = JSON.parse(ctx.files.readText(path)) as unknown;
		return Array.isArray(held) ? (held as GuestRecord[]) : [];
	} catch {
		return [];
	}
}

export function writeGuests(ctx: Context, state: string, guests: GuestRecord[]): void {
	ctx.files.writeText(`${state}/${GUESTS_FILE}`, `${JSON.stringify(guests, null, 2)}\n`);
}

export function recordGuest(ctx: Context, state: string, guest: GuestRecord): void {
	const held = readGuests(ctx, state).filter((entry) => entry.tenant !== guest.tenant);
	writeGuests(ctx, state, [...held, guest]);
}

export function forgetGuest(ctx: Context, state: string, tenant: string): void {
	writeGuests(
		ctx,
		state,
		readGuests(ctx, state).filter((entry) => entry.tenant !== tenant)
	);
}
