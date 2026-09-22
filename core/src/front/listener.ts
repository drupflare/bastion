export interface TlsMaterial {
	serverName: string;
	key: string;
	cert: string;
	/** the intermediate chain, where the CA ships one separately */
	ca?: string;
}

export interface ListenerSpec {
	address: string;
	tls?: TlsMaterial[];
	/** two listeners may hold one port, which is what makes a swap seamless */
	reusePort?: boolean;
	/**
	 * A unix socket path, which takes the place of the address when it is set.
	 *
	 * Every adapter bastion serves to a tenant is reached this way: workerd addresses them as
	 * `external` services at `unix:<path>`, so nothing an adapter holds is on a port and a tenant
	 * cannot reach another tenant's store by guessing one.
	 */
	unix?: string;
}

export interface Listener {
	port: number;
	hostname: string;
	/** stops accepting; resolves once in-flight requests have finished or been dropped */
	stop(force?: boolean): Promise<void>;
}

export type RequestHandler = (request: Request, peer: string) => Promise<Response>;

export interface ListenerHost {
	listen(spec: ListenerSpec, handler: RequestHandler): Listener;
}

export function parseAddress(address: string): { hostname: string; port: number } {
	const at = address.lastIndexOf(':');
	if (at === -1) return { hostname: '0.0.0.0', port: Number(address) };
	const hostname = address.slice(0, at) || '0.0.0.0';
	return { hostname: hostname.replace(/^\[|\]$/g, ''), port: Number(address.slice(at + 1)) };
}

/**
 * Binds a replacement listener and drains the old one.
 *
 * **Measured 2026-09-21, and this is not the obvious implementation.** `server.reload()` does NOT
 * re-read `tls`: a control proved the `tls: [{...}]` SNI array works when the server is born with
 * it and does not change when reloaded into one. So a cert renewal or a new tenant hostname
 * rebinds rather than reloading. `reusePort: true` lets both listeners hold the port at once, so
 * there is no window where nothing is bound.
 */
export async function swapListener(
	host: ListenerHost,
	current: Listener | null,
	spec: ListenerSpec,
	handler: RequestHandler
): Promise<Listener> {
	const next = host.listen({ ...spec, reusePort: true }, handler);
	if (current !== null) await current.stop(false);
	return next;
}

interface BunServe {
	port: number;
	hostname: string;
	stop(force?: boolean): void | Promise<void>;
}

interface BunGlobal {
	serve(options: Record<string, unknown>): BunServe;
}

/**
 * The listener as Bun implements it, resolved at call time.
 *
 * Resolved rather than imported so the gate lane typechecks and runs under node with this function
 * simply never called; every spec drives `handleRequest` and a scripted host instead.
 */
export function bunListenerHost(): ListenerHost {
	const bun = (globalThis as { Bun?: BunGlobal }).Bun;
	if (bun === undefined) {
		throw new Error(
			'the TLS front door needs the bun runtime; run the compiled bastion binary'
		);
	}
	return {
		listen(spec, handler) {
			const { hostname, port } = parseAddress(spec.address);
			const server = bun.serve({
				...(spec.unix === undefined
					? { hostname, port, reusePort: spec.reusePort === true }
					: { unix: spec.unix }),
				...(spec.tls === undefined
					? {}
					: {
							tls: spec.tls.map((m) => ({
								serverName: m.serverName,
								key: m.key,
								cert: m.cert,
								...(m.ca === undefined ? {} : { ca: m.ca })
							}))
						}),
				fetch(
					request: Request,
					server: { requestIP(r: Request): { address: string } | null }
				) {
					const peer = server.requestIP(request)?.address ?? '0.0.0.0';
					return handler(request, peer);
				}
			});
			return {
				port: spec.unix === undefined ? server.port : 0,
				hostname: spec.unix ?? server.hostname,
				stop: async (force = false) => {
					await server.stop(force);
				}
			};
		}
	};
}

/** a host that records what would have been bound, for the gate lane */
export function recordingListenerHost(): ListenerHost & {
	readonly bound: ListenerSpec[];
	readonly stopped: number[];
	readonly live: Listener[];
	/** each listener's handler, in bind order, so a spec drives a socket without opening one */
	readonly handlers: RequestHandler[];
} {
	const bound: ListenerSpec[] = [];
	const stopped: number[] = [];
	const live: Listener[] = [];
	const handlers: RequestHandler[] = [];
	let n = 0;
	return {
		bound,
		stopped,
		live,
		handlers,
		listen(spec, handler) {
			bound.push(spec);
			handlers.push(handler);
			const id = n++;
			const { hostname, port } = parseAddress(spec.address);
			const listener: Listener = {
				port: spec.unix === undefined ? port : 0,
				hostname: spec.unix ?? hostname,
				stop: async () => {
					stopped.push(id);
				}
			};
			live.push(listener);
			return listener;
		}
	};
}
