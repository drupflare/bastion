import { createServer } from 'node:http';
import { ADAPTER_SLOTS, handleSlot, type AdapterSet } from '../../../src/adapters/server';
import { socketFor } from '../../../src/capnp/plan';

export interface BoundAdapters {
	stop(): void;
	/** every error a slot raised, so a 500 in workerd's log has a reason on this side */
	readonly failures: string[];
}

/**
 * Binds one listener per adapter slot on the paths `socketFor` derives.
 *
 * The same sockets `Runtime` binds, so a lane that writes its own `config.capnp` reaches the same
 * adapters a real `bastion up` would. Without them the drupflare payload answers 500 on every
 * route: `connect(): No such file or directory; address = unix:.../kv.sock`, because it reads KV
 * and the Cache API before it renders anything.
 *
 * node rather than `Bun.serve`: vitest runs these files under node, so the bun global is absent.
 */
export async function bindAdapters(adapters: AdapterSet, dir: string): Promise<BoundAdapters> {
	const servers: { close(): void }[] = [];
	const failures: string[] = [];

	for (const slot of ADAPTER_SLOTS) {
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk: Buffer) => chunks.push(chunk));
			req.on('end', () => {
				const body = Buffer.concat(chunks);
				const headers: Record<string, string> = {};
				for (const [name, value] of Object.entries(req.headers)) {
					// only what bastion's own adapters read; forwarding `content-length` hands a
					// Request a length it then recalculates
					if (typeof value !== 'string') continue;
					if (name === 'content-type' || name.startsWith('x-bastion-')) {
						headers[name] = value;
					}
				}
				const url = new URL(`http://bastion${req.url ?? '/'}`);
				const request = new Request(url, {
					method: req.method,
					headers,
					...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body })
				});
				void handleSlot(adapters, slot, request, url.pathname)
					.then(async (answer) => {
						res.writeHead(answer.status, Object.fromEntries(answer.headers));
						res.end(Buffer.from(await answer.arrayBuffer()));
					})
					.catch((error: unknown) => {
						// surfaced rather than swallowed: a 500 carrying no reason is what made the
						// first run of this lane take three guesses to diagnose
						failures.push(`${slot}: ${String(error)}`);
						res.writeHead(500);
						res.end(String(error));
					});
			});
		});
		await new Promise<void>((resolve) =>
			server.listen(socketFor({ adapterDir: dir }, slot), resolve)
		);
		servers.push(server);
	}

	return {
		failures,
		stop: () => {
			for (const server of servers) server.close();
		}
	};
}
