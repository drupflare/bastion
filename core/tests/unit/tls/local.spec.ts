import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { scriptedRunner } from '../../../src/host/exec';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import {
	ANCHOR_DIR,
	mdnsCommand,
	platformTrustCommand,
	trustLocalCa,
	untrustLocalCa
} from '../../../src/tls/local';

const CA_CERT = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

function ctx(seed: Record<string, string> = {}, env: Record<string, string> = {}) {
	const files = memoryFiles(seed);
	const runner = scriptedRunner();
	return { context: { ...defaultContext(), files, runner, io: memoryIo(), env }, runner };
}

describe('trustLocalCa', () => {
	it('refuses a file carrying a private key, naming why', async () => {
		const { context } = ctx({
			'/ca.pem': '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----'
		});
		await expect(trustLocalCa(context, { caCertPath: '/ca.pem' })).rejects.toThrow(
			/never holds the key that signs with it/
		);
	});

	it('refuses a path that is not there', async () => {
		const { context } = ctx();
		await expect(trustLocalCa(context, { caCertPath: '/ca.pem' })).rejects.toThrow(/not there/);
	});

	it('uses mkcert when it is on PATH, so a developer trusts one CA rather than two', async () => {
		const { context, runner } = ctx(
			{ '/ca.pem': CA_CERT, '/usr/bin/mkcert': '' },
			{ PATH: '/usr/bin' }
		);
		const used = await trustLocalCa(context, { caCertPath: '/ca.pem' });
		expect(used.command).toBe('/usr/bin/mkcert');
		expect(runner.calls[0]?.args).toEqual(['-install']);
	});

	it('falls back to the platform trust store when mkcert is absent', async () => {
		const { context } = ctx({ '/ca.pem': CA_CERT }, { PATH: '/usr/bin' });
		const used = await trustLocalCa(context, { caCertPath: '/ca.pem' });
		expect(used.command).not.toBe('mkcert');
	});

	it('reverses the install', async () => {
		const { context, runner } = ctx({ '/usr/bin/mkcert': '' }, { PATH: '/usr/bin' });
		await untrustLocalCa(context, '/ca.pem');
		expect(runner.calls[0]?.args).toEqual(['-uninstall']);
	});
});

/**
 * Each platform asserted on its own terms.
 *
 * The platform is a parameter rather than whatever the build machine is, because these branches
 * call different binaries and write to different places. A suite that only asserts "not mkcert"
 * passes on both and proves neither, and the Linux branch is the one a bastion host actually runs.
 */
describe('trustLocalCa per platform', () => {
	it('copies the certificate into the anchor directory on linux, before refreshing', async () => {
		const { context, runner } = ctx(
			{ '/ca.pem': CA_CERT, '/usr/sbin/update-ca-certificates': '' },
			{ PATH: '/usr/sbin' }
		);
		const used = await trustLocalCa(context, { caCertPath: '/ca.pem' }, 'linux');
		// the refresh reads a directory, so a run without the copy is a no-op reporting success
		expect(context.files.exists(`${ANCHOR_DIR}/ca.pem`)).toBe(true);
		expect(used.command).toBe('update-ca-certificates');
		expect(runner.calls.map((call) => call.command)).toEqual(['update-ca-certificates']);
	});

	it('falls back to update-ca-trust where update-ca-certificates is absent', async () => {
		const { context } = ctx({ '/ca.pem': CA_CERT }, { PATH: '/usr/sbin' });
		const used = await trustLocalCa(context, { caCertPath: '/ca.pem' }, 'linux');
		expect(used).toEqual({ command: 'update-ca-trust', args: ['extract'] });
	});

	it('adds to the system keychain on darwin, and writes no anchor file', async () => {
		const { context } = ctx({ '/ca.pem': CA_CERT }, { PATH: '/usr/bin' });
		const used = await trustLocalCa(context, { caCertPath: '/ca.pem' }, 'darwin');
		expect(used.command).toBe('security');
		expect(used.args).toContain('add-trusted-cert');
		expect(context.files.exists(`${ANCHOR_DIR}/ca.pem`)).toBe(false);
	});

	it('removes the anchor it wrote on linux, rather than only refreshing', async () => {
		const { context, runner } = ctx(
			{ [`${ANCHOR_DIR}/ca.pem`]: CA_CERT },
			{ PATH: '/usr/sbin' }
		);
		await untrustLocalCa(context, '/ca.pem', 'linux');
		expect(context.files.exists(`${ANCHOR_DIR}/ca.pem`)).toBe(false);
		expect(runner.calls[0]?.args).toEqual(['--fresh']);
	});

	it('removes the trusted cert on darwin', async () => {
		const { context, runner } = ctx({}, { PATH: '/usr/bin' });
		await untrustLocalCa(context, '/ca.pem', 'darwin');
		expect(runner.calls[0]?.command).toBe('security');
		expect(runner.calls[0]?.args).toContain('remove-trusted-cert');
	});
});

describe('platformTrustCommand', () => {
	it('prefers update-ca-certificates where it exists', () => {
		const { context } = ctx({ '/usr/sbin/update-ca-certificates': '' }, { PATH: '/usr/sbin' });
		const command = platformTrustCommand(context, '/ca.pem', 'linux');
		expect(command.command).toBe('update-ca-certificates');
	});

	it('uses the keychain on darwin regardless of what is on PATH', () => {
		const { context } = ctx({ '/usr/sbin/update-ca-certificates': '' }, { PATH: '/usr/sbin' });
		expect(platformTrustCommand(context, '/ca.pem', 'darwin').command).toBe('security');
	});
});

describe('mdnsCommand', () => {
	it('publishes over mDNS rather than NetBIOS', () => {
		const command = mdnsCommand('bastion', 8787);
		expect(['avahi-publish', 'dns-sd']).toContain(command.command);
		expect(command.command).not.toBe('nmbd');
	});

	it('advertises the http service on the given port', () => {
		expect(mdnsCommand('bastion', 8787).args.join(' ')).toContain('_http._tcp');
		expect(mdnsCommand('bastion', 8787).args).toContain('8787');
	});

	it('uses avahi on linux and dns-sd on darwin', () => {
		expect(mdnsCommand('bastion', 8787, 'linux')).toMatchObject({
			command: 'avahi-publish',
			available: 'avahi'
		});
		expect(mdnsCommand('bastion', 8787, 'darwin')).toMatchObject({
			command: 'dns-sd',
			available: 'dns-sd'
		});
	});
});
