import { describe, expect, it } from 'vitest';
import {
	LARGE_RANGE_FLAG,
	checkRange,
	destination,
	expandCidr,
	installCommands,
	provision,
	refusingTransport,
	replayTransport,
	sshArgs,
	sshTransport,
	type ProvisionOptions
} from '../../../src/cluster/provision';
import { scriptedRunner } from '../../../src/host/exec';

const options: ProvisionOptions = {
	controlAddress: '10.0.0.1:8788',
	joinToken: 'one-time',
	version: '1.0.0',
	principal: 'operator'
};

describe('sshArgs', () => {
	it('sets BatchMode, so a missing key fails rather than hanging on a prompt', () => {
		expect(sshArgs({ host: 'h' }, 'true')).toContain('BatchMode=yes');
	});

	it('passes the remote command as the last argument rather than building a shell string', () => {
		const args = sshArgs({ host: 'h', user: 'root', port: 2222, identity: '/k' }, 'echo hello');
		expect(args[args.length - 1]).toBe('echo hello');
		expect(args).toContain('root@h');
		expect(args).toContain('2222');
	});

	it('names a host with no user as itself', () => {
		expect(destination({ host: 'h' })).toBe('h');
	});

	it('runs through the injected runner rather than opening anything itself', async () => {
		const runner = scriptedRunner({ ssh: { code: 0, stdout: 'empty', stderr: '' } });
		const transport = sshTransport(runner, { host: 'h' });
		expect(await transport.exec('true')).toMatchObject({ code: 0 });
		expect(runner.calls[0]?.command).toBe('ssh');
	});
});

describe('expandCidr', () => {
	it('expands a /30 to its two usable addresses', () => {
		expect(expandCidr('10.0.0.0/30')).toEqual(['10.0.0.1', '10.0.0.2']);
	});

	it('expands a /24 to 254 hosts', () => {
		expect(expandCidr('10.0.1.0/24')).toHaveLength(254);
	});

	it('treats a /32 as one address', () => {
		expect(expandCidr('10.0.0.5/32')).toEqual(['10.0.0.5']);
	});

	it('refuses something that is not a range', () => {
		expect(() => expandCidr('not/a/range')).toThrow(/not an IPv4 range/);
		expect(() => expandCidr('10.0.0.0/99')).toThrow(/not an IPv4 range/);
	});
});

describe('checkRange', () => {
	it('refuses a range wider than a /24 and says how many addresses it expands to', () => {
		const refusal = checkRange('10.0.0.0/16', { ...options, dryRun: true });
		expect(refusal.ok).toBe(false);
		expect(refusal.reason).toContain(LARGE_RANGE_FLAG);
		expect(refusal.reason).toContain('65534 addresses');
	});

	it('accepts a wide range once acknowledged', () => {
		expect(
			checkRange('10.0.0.0/16', { ...options, dryRun: true, acknowledgeLargeRange: true }).ok
		).toBe(true);
	});

	it('refuses to act on a range that has not been dry-run', () => {
		expect(checkRange('10.0.1.0/24', options).ok).toBe(false);
		expect(checkRange('10.0.1.0/24', { ...options, yes: true }).ok).toBe(true);
	});
});

describe('installCommands', () => {
	it('checks whether the host is empty before anything else', () => {
		expect(installCommands(options)[0]).toContain('/var/lib/bastion');
	});

	it('gives the child an address and a one-time token, never a secret in a config', () => {
		const joined = installCommands(options).join('\n');
		expect(joined).toContain('cluster join --control 10.0.0.1:8788 --token one-time');
		expect(joined).not.toContain('secretAccessKey');
	});
});

describe('provision', () => {
	const target = { host: '10.0.1.5' };

	it('changes nothing on a dry run and still prints a per-host plan', async () => {
		const transport = refusingTransport('10.0.1.5');
		const outcomes = await provision([{ target, transport }], { ...options, dryRun: true });
		expect(outcomes[0]?.action).toBe('would-install');
		expect(outcomes[0]?.commands.length).toBeGreaterThan(0);
		expect(transport.attempted).toEqual([]);
	});

	it('skips a host that already has a bastion, by name, rather than overwriting it', async () => {
		const transport = replayTransport('10.0.1.5', {
			[installCommands(options)[0] as string]: { code: 0, stdout: 'occupied\n', stderr: '' }
		});
		const outcomes = await provision([{ target, transport }], { ...options, yes: true });
		expect(outcomes[0]?.action).toBe('skipped');
		expect(outcomes[0]?.reason).toContain('not overwritten');
	});

	it('installs on an empty host', async () => {
		const commands = installCommands(options);
		const transcript = Object.fromEntries(
			commands.map((command, index) => [
				command,
				{ code: 0, stdout: index === 0 ? 'empty\n' : '', stderr: '' }
			])
		);
		const outcomes = await provision(
			[{ target, transport: replayTransport('10.0.1.5', transcript) }],
			{ ...options, yes: true }
		);
		expect(outcomes[0]?.action).toBe('installed');
	});

	it('reports the step that failed rather than continuing past it', async () => {
		const commands = installCommands(options);
		const transcript: Record<string, { code: number; stdout: string; stderr: string }> = {
			[commands[0] as string]: { code: 0, stdout: 'empty\n', stderr: '' },
			[commands[1] as string]: { code: 0, stdout: '', stderr: '' },
			[commands[2] as string]: { code: 7, stdout: '', stderr: 'no route to host' }
		};
		const outcomes = await provision(
			[{ target, transport: replayTransport('10.0.1.5', transcript) }],
			{ ...options, yes: true }
		);
		expect(outcomes[0]?.action).toBe('failed');
		expect(outcomes[0]?.reason).toContain('no route to host');
	});

	it('honours --only and --exclude', async () => {
		const transport = refusingTransport('x');
		const targets = [
			{ target: { host: 'a' }, transport },
			{ target: { host: 'b' }, transport }
		];
		const only = await provision(targets, { ...options, dryRun: true, only: ['a'] });
		expect(only.map((o) => o.host)).toEqual(['a']);
		const excluded = await provision(targets, { ...options, dryRun: true, exclude: ['a'] });
		expect(excluded.find((o) => o.host === 'a')?.action).toBe('skipped');
	});
});
