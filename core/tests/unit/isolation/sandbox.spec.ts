import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { scriptedRunner } from '../../../src/host/exec';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import {
	apparmorProfile,
	apparmorProfileName,
	createNetns,
	installApparmorProfile,
	netnsName,
	sandboxArgv,
	SYSCALL_DENY,
	type SandboxPaths
} from '../../../src/isolation/sandbox';
import { FORBIDDEN_FLAGS } from '../../../src/workerd/binary';

const paths: SandboxPaths = {
	state: '/var/lib/bastion/tenants/acme',
	config: '/var/lib/bastion/tenants/acme/config.capnp',
	netns: 'bastion-acme',
	apparmorProfile: 'bastion-tenant-acme',
	cgroup: '/sys/fs/cgroup/bastion.slice/tenant-acme'
};

function ctx() {
	const files = memoryFiles();
	const runner = scriptedRunner();
	return {
		context: { ...defaultContext(), files, runner, io: memoryIo(), env: {} },
		files,
		runner
	};
}

describe('sandboxArgv', () => {
	it('adds nothing in solo; the cgroup is the boundary and it is not in the argv', () => {
		const wrapped = sandboxArgv({ mode: 'solo', tenant: 'acme', paths }, 'workerd', ['serve']);
		expect(wrapped).toEqual({ command: 'workerd', args: ['serve'] });
	});

	it('adds nothing in isolated either; the VM is already the wall', () => {
		const wrapped = sandboxArgv({ mode: 'isolated', tenant: 'acme', paths }, 'workerd', [
			'serve'
		]);
		expect(wrapped.command).toBe('workerd');
	});

	it('composes the namespace, the profile and the filter in hardened', () => {
		const wrapped = sandboxArgv({ mode: 'hardened', tenant: 'acme', paths }, 'workerd', [
			'serve'
		]);
		const line = [wrapped.command, ...wrapped.args].join(' ');
		expect(wrapped.command).toBe('systemd-run');
		expect(line).toContain('ip netns exec bastion-acme');
		expect(line).toContain('aa-exec -p bastion-tenant-acme');
		expect(line.endsWith('workerd serve')).toBe(true);
	});

	it('denies every group in the list', () => {
		const wrapped = sandboxArgv({ mode: 'hardened', tenant: 'acme', paths }, 'workerd', []);
		for (const group of SYSCALL_DENY) {
			expect(wrapped.args).toContain(`SystemCallFilter=~${group}`);
		}
	});

	it('refuses new privileges, so a setuid binary inside cannot climb out', () => {
		const wrapped = sandboxArgv({ mode: 'hardened', tenant: 'acme', paths }, 'workerd', []);
		expect(wrapped.args).toContain('NoNewPrivileges=yes');
	});

	it.each(['solo', 'hardened', 'isolated'] as const)(
		'never introduces a forbidden workerd flag in %s',
		(mode) => {
			const wrapped = sandboxArgv({ mode, tenant: 'acme', paths }, 'workerd', ['serve', 'c']);
			for (const flag of FORBIDDEN_FLAGS) {
				expect(wrapped.args).not.toContain(flag);
			}
		}
	);

	it('names the namespace and the profile per tenant, so two tenants never share one', () => {
		expect(netnsName('acme')).not.toBe(netnsName('labs'));
		expect(apparmorProfileName('acme')).not.toBe(apparmorProfileName('labs'));
	});
});

describe('apparmorProfile', () => {
	const profile = apparmorProfile('acme', paths, '/usr/local/bin/workerd');

	it('grants the tenant its own state and nothing else writable', () => {
		expect(profile).toContain(`${paths.state}/** rwk,`);
		expect(profile).toContain(`${paths.config} r,`);
	});

	it('denies the paths an escaped tenant would reach for first', () => {
		for (const denied of ['/etc/shadow', '/root/**', '/var/lib/bastion/secrets/**']) {
			expect(profile).toContain(`deny ${denied}`);
		}
	});

	it('denies ptrace and mount outright', () => {
		expect(profile).toContain('deny ptrace,');
		expect(profile).toContain('deny mount,');
	});

	it('is installed by reloading the parser, not by asking the operator to', async () => {
		const { context, files, runner } = ctx();
		await installApparmorProfile(context, 'acme', paths, '/usr/local/bin/workerd');
		expect(files.exists('/etc/apparmor.d/bastion-tenant-acme')).toBe(true);
		expect(runner.calls[0]?.command).toBe('apparmor_parser');
		expect(runner.calls[0]?.args).toContain('-r');
	});
});

describe('createNetns', () => {
	it('creates the namespace and brings loopback up, and nothing else', async () => {
		const { context, runner } = ctx();
		await createNetns(context, 'acme');
		expect(runner.calls.map((c) => c.args.join(' '))).toEqual([
			'netns add bastion-acme',
			'netns exec bastion-acme ip link set lo up'
		]);
	});

	it('adds no route off the box, which is what makes egress denied by default', async () => {
		const { context, runner } = ctx();
		await createNetns(context, 'acme');
		const lines = runner.calls.map((c) => c.args.join(' ')).join('\n');
		expect(lines).not.toContain('veth');
		expect(lines).not.toContain('default');
	});
});
