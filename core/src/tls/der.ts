/** DER tag bytes, only the ones a CSR needs */
export const TAG = {
	INTEGER: 0x02,
	BIT_STRING: 0x03,
	OCTET_STRING: 0x04,
	OID: 0x06,
	UTF8: 0x0c,
	SEQUENCE: 0x30,
	SET: 0x31,
	IA5: 0x16
} as const;

export function length(n: number): Uint8Array {
	if (n < 0x80) return new Uint8Array([n]);
	const bytes: number[] = [];
	let value = n;
	while (value > 0) {
		bytes.unshift(value & 0xff);
		value >>= 8;
	}
	return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, contents: Uint8Array): Uint8Array {
	const size = length(contents.length);
	const out = new Uint8Array(1 + size.length + contents.length);
	out[0] = tag;
	out.set(size, 1);
	out.set(contents, 1 + size.length);
	return out;
}

export function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

export function sequence(...parts: Uint8Array[]): Uint8Array {
	return tlv(TAG.SEQUENCE, concat(parts));
}

export function set(...parts: Uint8Array[]): Uint8Array {
	return tlv(TAG.SET, concat(parts));
}

export function context(n: number, contents: Uint8Array, constructed = true): Uint8Array {
	return tlv((constructed ? 0xa0 : 0x80) | n, contents);
}

export function integer(value: number): Uint8Array {
	if (value === 0) return tlv(TAG.INTEGER, new Uint8Array([0]));
	const bytes: number[] = [];
	let rest = value;
	while (rest > 0) {
		bytes.unshift(rest & 0xff);
		rest >>= 8;
	}
	if (((bytes[0] as number) & 0x80) !== 0) bytes.unshift(0);
	return tlv(TAG.INTEGER, new Uint8Array(bytes));
}

/** a dotted OID as DER, which is base-128 with a combined first pair */
export function oid(dotted: string): Uint8Array {
	const parts = dotted.split('.').map(Number);
	const first = (parts[0] as number) * 40 + (parts[1] as number);
	const bytes: number[] = [first];
	for (const part of parts.slice(2)) {
		const chunk: number[] = [part & 0x7f];
		let rest = part >> 7;
		while (rest > 0) {
			chunk.unshift((rest & 0x7f) | 0x80);
			rest >>= 7;
		}
		bytes.push(...chunk);
	}
	return tlv(TAG.OID, new Uint8Array(bytes));
}

/** a BIT STRING with no unused trailing bits, which is the only form here */
export function bitString(contents: Uint8Array): Uint8Array {
	return tlv(TAG.BIT_STRING, concat([new Uint8Array([0]), contents]));
}

export function ia5(text: string): Uint8Array {
	return tlv(TAG.IA5, new TextEncoder().encode(text));
}

export function utf8(text: string): Uint8Array {
	return tlv(TAG.UTF8, new TextEncoder().encode(text));
}

export function octetString(contents: Uint8Array): Uint8Array {
	return tlv(TAG.OCTET_STRING, contents);
}

export interface Parsed {
	tag: number;
	contents: Uint8Array;
	end: number;
}

/** enough of a reader to let a spec assert what was encoded rather than compare opaque bytes */
export function parse(bytes: Uint8Array, at = 0): Parsed {
	const tag = bytes[at] as number;
	const first = bytes[at + 1] as number;
	if (first < 0x80) {
		return { tag, contents: bytes.subarray(at + 2, at + 2 + first), end: at + 2 + first };
	}
	const count = first & 0x7f;
	let size = 0;
	for (let i = 0; i < count; i++) size = (size << 8) | (bytes[at + 2 + i] as number);
	const start = at + 2 + count;
	return { tag, contents: bytes.subarray(start, start + size), end: start + size };
}

export function pem(label: string, der: Uint8Array): string {
	const body = Buffer.from(der).toString('base64');
	const lines = body.match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export function fromPem(text: string): Uint8Array {
	const body = text
		.split('\n')
		.filter((line) => !line.startsWith('-----'))
		.join('');
	return new Uint8Array(Buffer.from(body, 'base64'));
}
