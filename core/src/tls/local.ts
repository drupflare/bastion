import type { Context } from '../context';
import { BastionError } from '../errors';
import { binaryOnPath } from '../isolation/preflight';

export interface LocalTrustOptions {
	/** the PUBLIC certificate of the CA; the private half never lives here */
	caCertPath: string;
	mdns?: boolean;
}

/**
 * Installs a CA certificate into the host's trust store.
 *
 * **The CA's private key never lives on a bastion host.** `mkcert` states both halves of why:
 * `rootCA-key.pem` "gives complete power to intercept secure requests from your machine", and
 * separately, installing into the trust store does not need the CA key at all. A CA key on a
 * multi-tenant box is a MITM capability against every client that trusted it, and the threat model
 * for this phase already says a tenant escape reads that disk. So bastion generates the CA
 * off-host and ships only the public certificate plus a pre-signed leaf.
 *
 * Where `mkcert` is already on PATH it is used, because a developer who has already trusted its CA
 * should not be asked to trust a second one.
 */
export async function trustLocalCa(
	ctx: Context,
	options: LocalTrustOptions
): Promise<{ command: string; args: string[] }> {
	if (!ctx.files.exists(options.caCertPath)) {
		throw new BastionError('usage', `${options.caCertPath} is not there`);
	}
	const text = ctx.files.readText(options.caCertPath);
	if (text.includes('PRIVATE KEY')) {
		throw new BastionError(
			'capability-refused',
			'that file carries a private key. bastion installs a CA certificate and never holds the ' +
				'key that signs with it; generate the CA off-host and bring only the public half'
		);
	}
	const mkcert = binaryOnPath(ctx, 'mkcert');
	if (mkcert !== null) {
		const invocation = { command: mkcert, args: ['-install'] };
		await ctx.runner.run(invocation.command, invocation.args);
		return invocation;
	}

	// the update tools read a directory rather than a path, so the certificate is copied in
	// FIRST. Running the refresh without copying is a no-op that reports success, and `untrust`
	// already removes from exactly this path
	if (process.platform !== 'darwin') {
		ctx.files.writeText(`${ANCHOR_DIR}/${basename(options.caCertPath)}`, text);
	}
	const invocation = platformTrustCommand(ctx, options.caCertPath);
	await ctx.runner.run(invocation.command, invocation.args);
	return invocation;
}

/** where the Debian and Red Hat tools look for additional anchors */
export const ANCHOR_DIR = '/usr/local/share/ca-certificates';

export function platformTrustCommand(
	ctx: Context,
	caCertPath: string
): { command: string; args: string[] } {
	if (process.platform === 'darwin') {
		return {
			command: 'security',
			args: [
				'add-trusted-cert',
				'-d',
				'-r',
				'trustRoot',
				'-k',
				'/Library/Keychains/System.keychain',
				caCertPath
			]
		};
	}
	if (binaryOnPath(ctx, 'update-ca-certificates') !== null) {
		return { command: 'update-ca-certificates', args: [] };
	}
	return { command: 'update-ca-trust', args: ['extract'] };
}

export async function untrustLocalCa(ctx: Context, caCertPath: string): Promise<void> {
	const mkcert = binaryOnPath(ctx, 'mkcert');
	if (mkcert !== null) {
		await ctx.runner.run(mkcert, ['-uninstall']);
		return;
	}
	if (process.platform === 'darwin') {
		await ctx.runner.run('security', ['remove-trusted-cert', '-d', caCertPath]);
		return;
	}
	if (ctx.files.exists(`${ANCHOR_DIR}/${basename(caCertPath)}`)) {
		ctx.files.remove(`${ANCHOR_DIR}/${basename(caCertPath)}`);
	}
	await ctx.runner.run('update-ca-certificates', ['--fresh']);
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Publishes a `.local` name on the LAN.
 *
 * mDNS (RFC 6762), which is Avahi on Linux and `dns-sd` on macOS; modern Windows resolves it
 * natively. `nmbd` is NOT used and is not an alternative: it is NetBIOS name service on UDP 137 for
 * SMB clients and does not make `http://bastion.local` resolve in a browser.
 *
 * One caveat that is worth stating rather than discovering: mDNS is multicast on the local segment
 * and does not cross a VLAN without a reflector, so a campus with segmented networks sees the name
 * from one subnet only.
 */
export function mdnsCommand(
	name: string,
	port: number
): { command: string; args: string[]; available: 'avahi' | 'dns-sd' } {
	if (process.platform === 'darwin') {
		return {
			command: 'dns-sd',
			args: ['-P', name, '_http._tcp', 'local', String(port), `${name}.local`, '127.0.0.1'],
			available: 'dns-sd'
		};
	}
	return {
		command: 'avahi-publish',
		args: ['-s', name, '_http._tcp', String(port)],
		available: 'avahi'
	};
}
