import { describe, expect, it } from 'vitest';
import { memoryAdapters } from '../../../src/adapters/build';
import { defaultConfig } from '../../../src/config/defaults';
import type { BastionConfig } from '../../../src/config/types';
import { defaultContext } from '../../../src/context';
import { recordingListenerHost } from '../../../src/front/listener';
import { scriptedRunner } from '../../../src/host/exec';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import { GUEST_LAYOUT, readGuests } from '../../../src/isolation/guest';
import type { Guest, GuestSpec, Hypervisor } from '../../../src/isolation/hypervisor';
import { VSOCK_PORTS, type Stream, type StreamConnector } from '../../../src/isolation/vsock';
import { Runtime } from '../../../src/serve/runtime';

/**
 * `isolated` actually running a tenant in a guest.
 *
 * None of this could be asserted before, because nothing in the serving path ever created one:
 * `sandboxArgv` returned the command unwrapped on the grounds that the VM was the boundary, and no
 * VM was built. The mode an operator picks for mutually untrusted tenants was the weakest of the
 * three rather than the strongest, and every spec passed.
 */
const BUNDLE = '/srv/bundle';
const CHROOT = '/srv/bastion/jail/firecracker/bastion-acme/root';

const LINUX = {
	'/sys/fs/cgroup/cgroup.controllers': 'cpu memory pids',
	'/proc/self/ns/net': '',
	'/sys/module/apparmor/parameters/enabled': 'Y',
	'/proc/self/status': 'Seccomp:\t2\n',
	'/dev/kvm': '',
	'/usr/bin/ip': '',
	'/usr/bin/aa-exec': '',
	'/usr/bin/systemd-run': '',
	'/usr/bin/jailer': '',
	[`${BUNDLE}/index.js`]: 'export default { fetch: () => new Response("hi") };',
	'/srv/guest/vmlinux': 'kernel',
	'/srv/guest/rootfs.ext4': 'rootfs'
};

function recordingHypervisor(): { hypervisor: Hypervisor; specs: GuestSpec[] } {
	const specs: GuestSpec[] = [];
	const guests: Guest[] = [];
	return {
		specs,
		hypervisor: {
			id: () => 'recording',
			unavailableReason: () => null,
			chrootFor: (_ctx, tenant) => `/srv/bastion/jail/firecracker/bastion-${tenant}/root`,
			create: (_ctx, spec) => {
				specs.push(spec);
				const guest: Guest = {
					tenant: spec.tenant,
					state: 'running',
					pid: 4242,
					chroot: `/srv/bastion/jail/firecracker/bastion-${spec.tenant}/root`,
					vsock: spec.vsockUds,
					console: `/var/log/bastion/guests/${spec.tenant}.log`
				};
				guests.push(guest);
				return Promise.resolve(guest);
			},
			stop: () => Promise.resolve(),
			list: () => guests
		}
	};
}

function connectorAnswering(reply: string): { connector: StreamConnector; dialled: string[] } {
	const dialled: string[] = [];
	const chunks = [new TextEncoder().encode('OK 1\n'), new TextEncoder().encode(reply)];
	const stream: Stream = {
		write: () => Promise.resolve(),
		read: () => Promise.resolve(chunks.shift() ?? null),
		close: () => undefined
	};
	return {
		dialled,
		connector: {
			connect: (path) => {
				dialled.push(path);
				return Promise.resolve(stream);
			}
		}
	};
}

function harness(over: Partial<BastionConfig> = {}) {
	const base = defaultConfig();
	const config: BastionConfig = {
		...base,
		mode: 'isolated',
		state: '/var/lib/bastion',
		tenants: [
			{
				name: 'acme',
				limits: { cpu: '2', memory: 2 * 1024 * 1024 * 1024 },
				sites: [{ host: 'www.example.edu', bundle: BUNDLE }]
			}
		],
		...over
	};
	const files = memoryFiles({ ...LINUX });
	// mkfs and truncate are host tools; the gate scripts them rather than building an image
	const runner = scriptedRunner({
		truncate: { code: 0, stdout: '', stderr: '' },
		'mkfs.ext4': { code: 0, stdout: '', stderr: '' }
	});
	const ctx = {
		...defaultContext(),
		files,
		runner,
		io: memoryIo(),
		env: { PATH: '/usr/bin' },
		platform: 'linux',
		now: () => 1000
	};
	const recorder = recordingHypervisor();
	const host = recordingListenerHost();
	const runtime = new Runtime(ctx, {
		config,
		host,
		upstream: () => Promise.resolve(new Response('from the host')),
		platform: 'linux',
		binary: '/usr/bin/workerd',
		adapters: memoryAdapters,
		hypervisor: recorder.hypervisor,
		guestImage: { kernel: '/srv/guest/vmlinux', rootfs: '/srv/guest/rootfs.ext4' },
		acknowledgeUnsafeMode: true
	});
	return { ctx, files, runner, runtime, config, host, ...recorder };
}

describe('a tenant in isolated mode', () => {
	it('boots a guest rather than spawning workerd on the host', async () => {
		const h = harness();
		await h.runtime.startTenant('acme');
		expect(h.specs).toHaveLength(1);
		expect(h.specs[0]?.tenant).toBe('acme');
		// nothing was spawned; the host runs no workerd for this tenant at all
		expect(h.runner.calls.filter((call) => call.mode === 'spawn')).toHaveLength(0);
	});

	it('sizes the guest from the tenant limits rather than a fixed shape', async () => {
		const h = harness();
		await h.runtime.startTenant('acme');
		expect(h.specs[0]?.vcpus).toBe(2);
		expect(h.specs[0]?.memoryMib).toBe(2048);
	});

	/** the capnp is parsed INSIDE the guest, so a host path in it names nothing */
	it('generates a capnp against the guest layout, not the host state directory', async () => {
		const h = harness();
		await h.runtime.startTenant('acme');
		const capnp = h.files.readText('/var/lib/bastion/tenants/acme/config.capnp');
		expect(capnp).toContain(GUEST_LAYOUT.adapters);
		expect(capnp).toContain(GUEST_LAYOUT.listen);
		expect(capnp).not.toContain('/var/lib/bastion/tenants/acme/adapters');
	});

	it('carries the bundle onto the config drive, because the embeds resolve in the guest', async () => {
		const h = harness();
		await h.runtime.startTenant('acme');
		expect(h.files.exists('/var/lib/bastion/tenants/acme/guest/bundle/index.js')).toBe(true);
		expect(h.files.readText('/var/lib/bastion/tenants/acme/config.capnp')).toContain(
			'bundle/index.js'
		);
	});

	it('hands the guest a read-only config drive and a writable state drive', async () => {
		const h = harness();
		await h.runtime.startTenant('acme');
		expect(h.specs[0]?.config).toBe('/var/lib/bastion/tenants/acme/config.img');
		expect(h.specs[0]?.state).toBe('/var/lib/bastion/tenants/acme/state.img');
	});

	/**
	 * Firecracker delivers a guest-opened connection to `<uds>_<port>` and nowhere else.
	 *
	 * The address in the capnp is the GUEST's path, so binding that on the host would put every
	 * adapter on a socket the guest cannot see and leave the guest dialling a port nothing answers.
	 * workerd returns 500 to every request when its cache is one of them.
	 */
	it('binds each adapter on the host side of the guest vsock', async () => {
		const h = harness();
		await h.runtime.startTenant('acme');
		const unix = h.host.bound.map((spec) => spec.unix).filter((path) => path !== undefined);
		expect(unix).toContain(`${CHROOT}/bastion.vsock_${VSOCK_PORTS.cache}`);
		for (const path of unix) {
			expect(path?.startsWith(`${CHROOT}/bastion.vsock_`)).toBe(true);
			expect(path).not.toContain(GUEST_LAYOUT.adapters);
		}
	});

	it('records the guest where another process can read it', async () => {
		const h = harness();
		await h.runtime.startTenant('acme');
		const guests = readGuests(h.ctx, '/var/lib/bastion');
		expect(guests.map((guest) => guest.tenant)).toEqual(['acme']);
		expect(guests[0]?.console).toContain('acme');
	});

	it('stops and forgets the guest on the way down', async () => {
		const h = harness();
		await h.runtime.startTenant('acme');
		await h.runtime.down();
		expect(readGuests(h.ctx, '/var/lib/bastion')).toEqual([]);
	});
});

describe('reaching a tenant that runs in a guest', () => {
	it('dials the guest over vsock rather than a socket on the host', async () => {
		const h = harness();
		const { connector, dialled } = connectorAnswering('HTTP/1.1 200 OK\r\n\r\nfrom the guest');
		const runtime = new Runtime(h.ctx, {
			config: h.config,
			host: recordingListenerHost(),
			upstream: () => Promise.resolve(new Response('from the host')),
			platform: 'linux',
			hypervisor: h.hypervisor,
			connector
		});
		const answer = await (
			runtime as unknown as {
				tenantUpstream(): (
					route: { tenant: string },
					request: Request,
					client: string
				) => Promise<Response>;
			}
		).tenantUpstream()(
			{ tenant: 'acme' },
			new Request('https://www.example.edu/node/1'),
			'1.2.3.4'
		);
		expect(await answer.text()).toBe('from the guest');
		expect(dialled).toEqual([`${CHROOT}/bastion.vsock`]);
	});

	it('leaves the host upstream alone in every other mode', async () => {
		const h = harness({ mode: 'hardened' });
		const runtime = new Runtime(h.ctx, {
			config: { ...h.config, mode: 'hardened' },
			host: recordingListenerHost(),
			upstream: () => Promise.resolve(new Response('from the host')),
			platform: 'linux',
			hypervisor: h.hypervisor
		});
		const answer = await (
			runtime as unknown as {
				tenantUpstream(): (
					route: { tenant: string },
					request: Request,
					client: string
				) => Promise<Response>;
			}
		).tenantUpstream()({ tenant: 'acme' }, new Request('https://www.example.edu/'), '1.2.3.4');
		expect(await answer.text()).toBe('from the host');
	});
});

describe('the isolation the health tree reports', () => {
	/** echoing the configuration back is the one answer a downgrade check must never give */
	it('says no mode is available when the host lost the mechanism', () => {
		const files = memoryFiles({});
		const ctx = {
			...defaultContext(),
			files,
			runner: scriptedRunner(),
			io: memoryIo(),
			env: {},
			platform: 'linux'
		};
		const runtime = new Runtime(ctx, {
			config: { ...defaultConfig(), mode: 'isolated' },
			host: recordingListenerHost(),
			upstream: () => Promise.resolve(new Response('ok')),
			platform: 'linux'
		});
		const sample = runtime.sample();
		expect(sample.isolation?.available).toBeNull();
		expect(sample.isolation?.configured).toBe('isolated');
	});
});
