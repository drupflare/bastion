import { request } from 'node:http';

export interface SocketResponse {
	status: number;
	body: string;
	headers: Record<string, string | string[] | undefined>;
}

/**
 * Speaks HTTP to workerd over its unix socket, which is how bastion itself reaches it.
 *
 * A TCP listener would be the easier rig and it would be testing a shape bastion never generates:
 * `planSite` always emits `unix:` on the tenant's listen socket, because the front door terminates
 * TLS and proxies inward. One lane pointed at `127.0.0.1:<port>` and waited a minute on a
 * connection that could never be made, because the generator had turned that into the NAME of a
 * unix socket file.
 */
export function overSocket(
	socketPath: string,
	path: string,
	host = '127.0.0.1'
): Promise<SocketResponse> {
	return new Promise((resolve, reject) => {
		const req = request({ socketPath, path, method: 'GET', headers: { host } }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () =>
				resolve({
					status: res.statusCode ?? 0,
					body: Buffer.concat(chunks).toString(),
					headers: res.headers
				})
			);
		});
		req.on('error', reject);
		req.end();
	});
}
