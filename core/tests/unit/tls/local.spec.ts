import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { scriptedRunner } from '../../../src/host/exec';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import {
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

describe('platformTrustCommand', () => {
	it('prefers update-ca-certificates where it exists', () => {
		const { context } = ctx({ '/usr/sbin/update-ca-certificates': '' }, { PATH: '/usr/sbin' });
		const command = platformTrustCommand(context, '/ca.pem');
		expect(['update-ca-certificates', 'security']).toContain(command.command);
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
});
