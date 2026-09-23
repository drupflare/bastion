import { connect as netConnect } from 'node:net';
import { BastionError } from '../errors';

/**
 * A guest with no network interface still has to be reachable, and vsock is the only way in.
 *
 * Firecracker splits the two directions and they are not symmetric. A connection the GUEST opens
 * arrives on the host as a connection to `<uds>_<port>`, so bastion listens there and every
 * adapter stays an ordinary HTTP server over a unix socket. A connection the HOST opens goes to
 * `<uds>` itself and must be prefixed with a `CONNECT <port>` line, which is why serving traffic
 * needs this module and adapter traffic does not.
 */

/** the host end of a guest-initiated connection, which is where bastion binds one adapter */
export function guestPort(vsockUds: string, port: number): string {
	return `${vsockUds}_${port}`;
}

/**
 * One vsock port per thing the guest talks to, fixed so the guest image can hardcode them.
 *
 * Every entry of `ADAPTER_SLOTS` needs one. A slot with no port binds nothing on the host and the
 * guest dials a port nobody answers, which is a binding that validates, generates and then fails
 * at the first call -- and it fails quietly, because the tenant is the only one who sees it. A
 * spec holds this list against the slot list rather than trusting them to be edited together.
 */
export const VSOCK_PORTS = {
	/** bastion dials this to reach workerd inside the guest; every other port the guest dials out */
	serve: 8080,
	cache: 8081,
	kv: 8082,
	r2: 8083,
	queues: 8084,
	assets: 8085,
	sql: 8086,
	ai: 8087,
	vectorize: 8088,
	email: 8089,
	images: 8090,
	browser: 8091,
	analytics: 8092
} as const;

/** a duplex byte stream; a unix socket and a vsock connection are each one */
export interface Stream {
	write(bytes: Uint8Array): Promise<void>;
	/** the next chunk, or null once the peer is done writing */
	read(): Promise<Uint8Array | null>;
	close(): void;
}

/** the seam, so the gate lane drives the handshake and the parser without a hypervisor */
export interface StreamConnector {
	connect(path: string): Promise<Stream>;
}

export function nodeConnector(): StreamConnector {
	return {
		connect: (path) =>
			new Promise((resolve, reject) => {
				const socket = netConnect(path);
				const chunks: Uint8Array[] = [];
				let waiting: ((value: Uint8Array | null) => void) | null = null;
				let ended = false;

				const push = (chunk: Uint8Array | null): void => {
					if (waiting !== null) {
						const take = waiting;
						waiting = null;
						take(chunk);
						return;
					}
					if (chunk !== null) chunks.push(chunk);
				};

				socket.on('data', (data: Buffer) => push(new Uint8Array(data)));
				socket.on('end', () => {
					ended = true;
					push(null);
				});
				socket.on('error', (error) => {
					ended = true;
					push(null);
					reject(error);
				});
				socket.on('connect', () =>
					resolve({
						write: (bytes) =>
							new Promise((done, fail) => {
								socket.write(bytes, (error) =>
									error === undefined || error === null ? done() : fail(error)
								);
							}),
						read: () => {
							const held = chunks.shift();
							if (held !== undefined) return Promise.resolve(held);
							if (ended) return Promise.resolve(null);
							return new Promise((take) => {
								waiting = take;
							});
						},
						close: () => socket.destroy()
					})
				);
			})
	};
}

/** reads until `needle` appears, answering what came before it and keeping the rest */
async function readUntil(
	stream: Stream,
	needle: string,
	held: Uint8Array
): Promise<{ head: string; rest: Uint8Array }> {
	const decoder = new TextDecoder();
	let buffer = held;
	for (;;) {
		const text = decoder.decode(buffer, { stream: false });
		const at = text.indexOf(needle);
		if (at !== -1) {
			// index in BYTES, which is why the slice is measured on an encode of the head
			const head = text.slice(0, at);
			const consumed = new TextEncoder().encode(text.slice(0, at + needle.length)).length;
			return { head, rest: buffer.slice(consumed) };
		}
		const next = await stream.read();
		if (next === null) {
			throw new BastionError(
				'driver-unreachable',
				`the guest closed before sending ${needle}`
			);
		}
		const grown = new Uint8Array(buffer.length + next.length);
		grown.set(buffer);
		grown.set(next, buffer.length);
		buffer = grown;
	}
}

/**
 * The handshake Firecracker requires before a host-opened stream reaches the guest.
 *
 * `CONNECT <port>\n` in, and either `OK <assigned>\n` or a refusal. A guest that is up but has
 * nothing listening on the port answers the refusal, which is the common case while an image is
 * still booting, so it is reported as unreachable rather than as a protocol fault.
 */
export async function vsockHandshake(stream: Stream, port: number): Promise<Uint8Array> {
	await stream.write(new TextEncoder().encode(`CONNECT ${port}\n`));
	const { head, rest } = await readUntil(stream, '\n', new Uint8Array(0));
	if (!head.startsWith('OK')) {
		throw new BastionError(
			'driver-unreachable',
			`the guest refused a vsock connection on port ${port}: ${head.trim() || 'no answer'}`
		);
	}
	return rest;
}

function serialiseRequest(request: Request, body: Uint8Array): Uint8Array {
	const url = new URL(request.url);
	const headers: string[] = [];
	request.headers.forEach((value, name) => {
		if (name.toLowerCase() === 'content-length') return;
		headers.push(`${name}: ${value}`);
	});
	if (!request.headers.has('host')) headers.push(`host: ${url.host}`);
	headers.push(`content-length: ${body.length}`);
	// the guest closes the stream per request, which is what makes the body end unambiguous
	headers.push('connection: close');
	const head = `${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`;
	const encoded = new TextEncoder().encode(head);
	const out = new Uint8Array(encoded.length + body.length);
	out.set(encoded);
	out.set(body, encoded.length);
	return out;
}

async function readResponse(stream: Stream, held: Uint8Array): Promise<Response> {
	const { head, rest } = await readUntil(stream, '\r\n\r\n', held);
	const [statusLine, ...headerLines] = head.split('\r\n');
	const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine ?? '');
	if (match === null) {
		throw new BastionError('driver-unreachable', `the guest answered no status line: ${head}`);
	}
	const status = Number(match[1]);
	const headers = new Headers();
	for (const line of headerLines) {
		const at = line.indexOf(':');
		if (at === -1) continue;
		const name = line.slice(0, at).trim();
		// hop-by-hop, and a content-length that survives would contradict the body we assembled
		if (['connection', 'content-length', 'transfer-encoding'].includes(name.toLowerCase()))
			continue;
		headers.append(name, line.slice(at + 1).trim());
	}

	const chunks: Uint8Array[] = [rest];
	for (;;) {
		const next = await stream.read();
		if (next === null) break;
		chunks.push(next);
	}
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const body = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.length;
	}
	return new Response(status === 204 || status === 304 ? null : body, { status, headers });
}

/**
 * One request to workerd inside a guest.
 *
 * A connection per request, closed by the guest, because the alternative is keep-alive framing
 * across a transport that has no other way to say where a body ends.
 */
export async function vsockFetch(
	connector: StreamConnector,
	vsockUds: string,
	port: number,
	request: Request
): Promise<Response> {
	const body = new Uint8Array(await request.arrayBuffer());
	const stream = await connector.connect(vsockUds);
	try {
		const held = await vsockHandshake(stream, port);
		await stream.write(serialiseRequest(request, body));
		return await readResponse(stream, held);
	} finally {
		stream.close();
	}
}
