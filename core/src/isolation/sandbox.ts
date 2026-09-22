import type { Mode } from '../config/types';
import type { Context } from '../context';

/**
 * Syscall groups a workerd tenant never needs.
 *
 * Expressed as systemd's `SystemCallFilter` sets rather than as a compiled BPF program, because
 * that is the mechanism a Linux host already ships: no helper binary to build, no filter to keep
 * in sync with a libc bump, and the same syntax on every distribution that runs systemd. A host
 * without `systemd-run` cannot run `hardened`, and preflight refuses it by name rather than
 * quietly running `solo` in its place.
 */
export const SYSCALL_DENY = [
	'@mount',
	'@reboot',
	'@swap',
	'@module',
	'@obsolete',
	'@raw-io',
	'@clock',
	'@debug',
	'@cpu-emulation'
] as const;

export const SYSCALL_ALLOW = '@system-service';

export interface SandboxPaths {
	/** the tenant's state directory, the only writable path it gets */
	state: string;
	/** the generated config.capnp, readable by this tenant alone */
	config: string;
	netns: string;
	apparmorProfile: string;
	cgroup: string;
}

export interface SandboxOptions {
	mode: Mode;
	tenant: string;
	paths: SandboxPaths;
}

/** the network namespace name for a tenant; one per tenant, never shared */
export function netnsName(tenant: string): string {
	return `bastion-${tenant}`;
}

export function apparmorProfileName(tenant: string): string {
	return `bastion-tenant-${tenant}`;
}

/**
 * Wraps a workerd command in whatever the mode asks for.
 *
 * The wrappers compose outside-in: the namespace is entered first because everything after it must
 * be inside, the AppArmor profile is attached next because it is a property of the exec, and the
 * syscall filter is outermost because systemd owns the scope. `solo` adds nothing here -- its
 * boundary is the cgroup, which is applied to the process rather than to its argv.
 */
export function sandboxArgv(
	options: SandboxOptions,
	command: string,
	args: string[]
): { command: string; args: string[] } {
	if (options.mode === 'solo') return { command, args };
	if (options.mode === 'isolated') {
		// the guest has the VM around it; wrapping inside it as well buys nothing and Cloudflare's
		// own firecracker guests run with the full capability set for the same reason
		return { command, args };
	}

	const inner = ['aa-exec', '-p', apparmorProfileName(options.tenant), '--', command, ...args];
	const namespaced = ['ip', 'netns', 'exec', netnsName(options.tenant), ...inner];
	return {
		command: 'systemd-run',
		args: [
			'--scope',
			'--quiet',
			`--unit=bastion-${options.tenant}`,
			`-p`,
			`SystemCallFilter=${SYSCALL_ALLOW}`,
			...SYSCALL_DENY.flatMap((group) => ['-p', `SystemCallFilter=~${group}`]),
			'-p',
			'NoNewPrivileges=yes',
			'-p',
			'RestrictSUIDSGID=yes',
			'-p',
			'ProtectKernelTunables=yes',
			'-p',
			'ProtectKernelModules=yes',
			'--',
			...namespaced
		]
	};
}

/**
 * The AppArmor profile for one tenant.
 *
 * Deny-by-default: the tenant reads its own binary and config, writes its own state directory, and
 * nothing else. The explicit denials at the end are the paths that would otherwise be readable
 * through the default `/etc` and `/proc` allowances and are worth naming because each one is a
 * credential or a fingerprint an escaped tenant would go for first.
 */
export function apparmorProfile(tenant: string, paths: SandboxPaths, binary: string): string {
	const name = apparmorProfileName(tenant);
	return [
		'abi <abi/4.0>,',
		'include <tunables/global>',
		'',
		`profile ${name} flags=(attach_disconnected) {`,
		'\tinclude <abstractions/base>',
		'',
		`\t${binary} rix,`,
		`\t${paths.config} r,`,
		`\t${paths.state}/ rw,`,
		`\t${paths.state}/** rwk,`,
		'',
		'\tnetwork inet stream,',
		'\tnetwork inet6 stream,',
		'\tnetwork unix stream,',
		'',
		'\tdeny /etc/shadow r,',
		'\tdeny /etc/ssh/** r,',
		'\tdeny /root/** rw,',
		'\tdeny /home/** rw,',
		'\tdeny /var/lib/bastion/secrets/** rw,',
		'\tdeny @{PROC}/sys/kernel/** w,',
		'\tdeny mount,',
		'\tdeny ptrace,',
		'}',
		''
	].join('\n');
}

export function installApparmorProfile(
	ctx: Context,
	tenant: string,
	paths: SandboxPaths,
	binary: string
): Promise<{ code: number; stdout: string; stderr: string }> {
	const path = `/etc/apparmor.d/${apparmorProfileName(tenant)}`;
	ctx.files.writeText(path, apparmorProfile(tenant, paths, binary));
	return ctx.runner.run('apparmor_parser', ['-r', '-W', path]);
}

/**
 * Creates the tenant's network namespace with no route off the box.
 *
 * Egress is denied here as well as in `globalOutbound` because the two fail differently: the
 * config layer is bypassed by a workerd bug, and the namespace is not. A Worker's `fetch` egresses
 * from the operator's LAN, so on a self-hosted box the default posture is SSRF into the internal
 * network -- metadata endpoints, the hypervisor management interface, other tenants' admin ports,
 * bastion's own dashboard on localhost.
 */
export async function createNetns(ctx: Context, tenant: string): Promise<string[]> {
	const ns = netnsName(tenant);
	const steps: string[][] = [
		['netns', 'add', ns],
		['netns', 'exec', ns, 'ip', 'link', 'set', 'lo', 'up']
	];
	for (const args of steps) await ctx.runner.run('ip', args);
	return steps.map((s) => s.join(' '));
}

export async function deleteNetns(ctx: Context, tenant: string): Promise<void> {
	await ctx.runner.run('ip', ['netns', 'delete', netnsName(tenant)]);
}
