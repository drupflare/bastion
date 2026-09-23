import { describe, expect, it } from 'vitest';
import { ADAPTER_SLOTS } from '../../../src/adapters/server';
import {
	guestPort,
	VSOCK_PORTS,
	vsockFetch,
	vsockHandshake,
	type Stream,
	type StreamConnector
} from '../../../src/isolation/vsock';

/**
 * A scripted stream, so the handshake and the parser are driven without a hypervisor.
 *
 * It answers in the chunk boundaries it was given rather than one buffer, because a socket splits
 * wherever it likes and a parser that only works on whole messages works only in a test.
 */
function scripted(replies: string[]): { connector: StreamConnector; written: () => string } {
	const chunks = replies.map((reply) => new TextEncoder().encode(reply));
	const sent: Uint8Array[] = [];
	const stream: Stream = {
		write: (bytes) => {
			sent.push(bytes);
			return Promise.resolve();
		},
		read: () => Promise.resolve(chunks.shift() ?? null),
		close: () => undefined
	};
	return {
		connector: { connect: () => Promise.resolve(stream) },
		written: () => sent.map((chunk) => new TextDecoder().decode(chunk)).join('')
	};
}

const ask = (path = '/serve'): Request => new Request(`https://www.example.edu${path}`);

describe('the vsock port map', () => {
	it('gives every slot its own port, so the guest image can hardcode them', () => {
		const ports = Object.values(VSOCK_PORTS);
		expect(new Set(ports).size).toBe(ports.length);
	});

	/**
	 * A slot with no port binds nothing on the host, so the guest dials one nobody answers. That
	 * is a binding which validates and generates and then fails on its first call, seen only by
	 * the tenant. Six of the twelve were missing, and `sql` was listed under the binding's name.
	 */
	it('covers every adapter slot bastion serves', () => {
		for (const slot of ADAPTER_SLOTS) {
			expect(Object.keys(VSOCK_PORTS), `${slot} has no vsock port`).toContain(slot);
		}
	});

	/** firecracker delivers a guest-opened connection to `<uds>_<port>` and nowhere else */
	it('names the host socket a guest-opened connection arrives on', () => {
		expect(guestPort('/srv/jail/bastion.vsock', 8082)).toBe('/srv/jail/bastion.vsock_8082');
	});
});

describe('the handshake', () => {
	it('asks for the port firecracker expects', async () => {
		const { connector, written } = scripted(['OK 1024\n']);
		await vsockHandshake(await connector.connect('/x'), VSOCK_PORTS.serve);
		expect(written()).toBe('CONNECT 8080\n');
	});

	it('keeps bytes that arrived in the same chunk as the greeting', async () => {
		const { connector } = scripted(['OK 1024\nHTTP/1.1 200 OK\r\n']);
		const rest = await vsockHandshake(await connector.connect('/x'), 8080);
		expect(new TextDecoder().decode(rest)).toBe('HTTP/1.1 200 OK\r\n');
	});

	/** a booting guest answers this, so it is unreachable rather than a protocol fault */
	it('reports a refusal as the guest not listening yet', async () => {
		const { connector } = scripted(['ERROR bad port\n']);
		await expect(vsockHandshake(await connector.connect('/x'), 8080)).rejects.toThrow(
			/refused a vsock connection on port 8080/
		);
	});

	it('says so when the guest closes without answering at all', async () => {
		const { connector } = scripted([]);
		await expect(vsockHandshake(await connector.connect('/x'), 8080)).rejects.toThrow(
			/closed before sending/
		);
	});
});

describe('vsockFetch', () => {
	it('sends the request line and host after the handshake', async () => {
		const { connector, written } = scripted(['OK 1024\n', 'HTTP/1.1 200 OK\r\n\r\nhi']);
		await vsockFetch(connector, '/srv/bastion.vsock', 8080, ask('/node/1'));
		expect(written()).toContain('CONNECT 8080\n');
		expect(written()).toContain('GET /node/1 HTTP/1.1\r\n');
		expect(written()).toContain('host: www.example.edu');
	});

	it('answers the status and body the guest sent', async () => {
		const { connector } = scripted([
			'OK 1\n',
			'HTTP/1.1 201 Created\r\nx-who: guest\r\n\r\nmade'
		]);
		const answer = await vsockFetch(connector, '/s', 8080, ask());
		expect(answer.status).toBe(201);
		expect(answer.headers.get('x-who')).toBe('guest');
		expect(await answer.text()).toBe('made');
	});

	it('reassembles a body split across chunks, which is how a socket delivers one', async () => {
		const { connector } = scripted([
			'OK 1\n',
			'HTTP/1.1 200 OK\r\n\r\nthe ',
			'page ',
			'rendered'
		]);
		expect(await (await vsockFetch(connector, '/s', 8080, ask())).text()).toBe(
			'the page rendered'
		);
	});

	it('handles a status line split from its headers', async () => {
		const { connector } = scripted(['OK 1\n', 'HTTP/1.1 200 ', 'OK\r\nx-a: b', '\r\n\r\nok']);
		const answer = await vsockFetch(connector, '/s', 8080, ask());
		expect(answer.status).toBe(200);
		expect(answer.headers.get('x-a')).toBe('b');
	});

	it('carries a request body and declares its length', async () => {
		const { connector, written } = scripted(['OK 1\n', 'HTTP/1.1 200 OK\r\n\r\n']);
		await vsockFetch(
			connector,
			'/s',
			8080,
			new Request('https://www.example.edu/post', { method: 'POST', body: 'name=acme' })
		);
		expect(written()).toContain('POST /post HTTP/1.1');
		expect(written()).toContain('content-length: 9');
		expect(written()).toContain('name=acme');
	});

	/** two of these would disagree, and the one the guest sent describes a body already consumed */
	it('drops the hop-by-hop headers rather than passing them to the caller', async () => {
		const { connector } = scripted([
			'OK 1\n',
			'HTTP/1.1 200 OK\r\ncontent-length: 99\r\nconnection: close\r\n\r\nshort'
		]);
		const answer = await vsockFetch(connector, '/s', 8080, ask());
		expect(answer.headers.get('connection')).toBeNull();
		expect(await answer.text()).toBe('short');
	});

	it('keeps a 204 empty rather than giving it a body', async () => {
		const { connector } = scripted(['OK 1\n', 'HTTP/1.1 204 No Content\r\n\r\n']);
		const answer = await vsockFetch(connector, '/s', 8080, ask());
		expect(answer.status).toBe(204);
		expect(await answer.text()).toBe('');
	});

	it('refuses an answer that is not http rather than returning an empty page', async () => {
		const { connector } = scripted(['OK 1\n', 'this is not a response\r\n\r\n']);
		await expect(vsockFetch(connector, '/s', 8080, ask())).rejects.toThrow(/no status line/);
	});

	it('passes the query string, which is where a cache key lives', async () => {
		const { connector, written } = scripted(['OK 1\n', 'HTTP/1.1 200 OK\r\n\r\n']);
		await vsockFetch(connector, '/s', 8080, ask('/search?q=bastion&page=2'));
		expect(written()).toContain('GET /search?q=bastion&page=2 HTTP/1.1');
	});
});
