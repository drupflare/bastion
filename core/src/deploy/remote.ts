/**
 * Downloading a template or a bundle from a url, with the checks that have to happen first.
 *
 * An operator who types a url is asking bastion to fetch code and run it as a tenant, from the
 * host's own network position. Three things follow, and each is a refusal rather than a warning:
 * plaintext is a man-in-the-middle away from arbitrary code, a url that resolves into the private
 * ranges is the same SSRF the egress policy exists to stop, and a body with no ceiling fills the
 * disk that every tenant shares.
 *
 * The address check runs on every hop. A public host that redirects to `169.254.169.254` is the
 * standard way past a check that only looks at what the operator typed.
 */

import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { Context } from '../context';
import { NEVER_REACHABLE } from '../egress/policy';
import { BastionError } from '../errors';

export interface RemoteSource {
	/** the url the bytes finally came from, which is the last hop rather than the first */
	url: string;
	/** every url in the chain, the one the operator gave first */
	hops: string[];
	/** what the server said it would send, or -1 when it did not say */
	declared: number;
	contentType: string;
}

export interface RemoteOptions {
	/** the ceiling; a body over it is refused rather than truncated */
	maxBytes: number;
	/** `sha256:<hex>`, compared against what arrived */
	checksum?: string;
	/** allows plaintext and a private address, for a mirror on the operator's own network */
	insecure?: boolean;
	/** how a hostname becomes an address; a seam, so the gate lane drives both answers */
	resolve?: (host: string) => Promise<string[]>;
	maxHops?: number;
}

export const MAX_HOPS = 5;

export function isRemote(source: string): boolean {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
}

/** an address as bytes, so one comparison covers both families; null when it is not an address */
export function addressBytes(ip: string): Uint8Array | null {
	if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
		const parts = ip.split('.').map(Number);
		if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
		return Uint8Array.from(parts);
	}
	if (!ip.includes(':')) return null;

	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	if (mapped !== null) return addressBytes(mapped[1] as string);

	const halves = ip.split('::');
	if (halves.length > 2) return null;
	const piece = (text: string): string[] => (text === '' ? [] : text.split(':'));
	const head = piece(halves[0] as string);
	const tail = halves.length === 2 ? piece(halves[1] as string) : [];
	const groups =
		halves.length === 2
			? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
			: head;
	if (groups.length !== 8) return null;

	const bytes = new Uint8Array(16);
	for (let i = 0; i < 8; i += 1) {
		const group = groups[i] as string;
		if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
		const value = parseInt(group, 16);
		bytes[i * 2] = value >> 8;
		bytes[i * 2 + 1] = value & 0xff;
	}
	return bytes;
}

/** the denied range this address falls in, or null; the ranges are the egress policy's own */
export function deniedRange(ip: string): string | null {
	const address = addressBytes(ip);
	if (address === null) return null;
	for (const cidr of NEVER_REACHABLE) {
		const [base, width] = cidr.split('/');
		const network = addressBytes(base as string);
		if (network === null || network.length !== address.length) continue;
		let bits = Number(width);
		let index = 0;
		let matched = true;
		while (bits > 0 && matched) {
			const take = Math.min(8, bits);
			const mask = (0xff << (8 - take)) & 0xff;
			if (((address[index] as number) & mask) !== ((network[index] as number) & mask)) {
				matched = false;
			}
			bits -= take;
			index += 1;
		}
		if (matched) return cidr;
	}
	return null;
}

const defaultResolve = async (host: string): Promise<string[]> => {
	const answers = await lookup(host, { all: true });
	return answers.map((answer) => answer.address);
};

/**
 * Refuses a url bastion should not fetch, before it is fetched.
 *
 * Every address the name resolves to is checked rather than the first: a name with one public and
 * one loopback answer is a round-robin away from reaching the management listener.
 */
export async function assertFetchable(url: string, options: RemoteOptions): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new BastionError('usage', `${url} is not a url`, { next: null });
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new BastionError(
			'usage',
			`bastion downloads over https, not ${parsed.protocol.replace(':', '')}`,
			{ next: null }
		);
	}
	if (parsed.protocol === 'http:' && options.insecure !== true) {
		throw new BastionError('usage', `${url} is plaintext, and this becomes a tenant's code`, {
			next: 'pass --insecure-source to accept an unauthenticated download'
		});
	}

	const host = parsed.hostname.replace(/^\[|\]$/g, '');
	const literal = deniedRange(host);
	const addresses = literal !== null ? [host] : await (options.resolve ?? defaultResolve)(host);
	if (addresses.length === 0) {
		throw new BastionError('usage', `${host} resolves to nothing`, { retryable: true });
	}
	for (const address of addresses) {
		const range = deniedRange(address);
		if (range === null || options.insecure === true) continue;
		throw new BastionError(
			'usage',
			`${host} resolves to ${address}, which is in ${range}: the host's own network, not the internet`,
			{ next: 'pass --insecure-source when the mirror really is on this network' }
		);
	}
}

/**
 * Follows the redirect chain, checking every hop, and reports what the server says it will send.
 *
 * A server that refuses HEAD reports `declared: -1`, which is not a failure: the ceiling is still
 * enforced against the bytes that actually arrive.
 */
export async function probeRemote(
	ctx: Context,
	url: string,
	options: RemoteOptions
): Promise<RemoteSource> {
	const hops: string[] = [];
	let current = url;

	for (let hop = 0; hop <= (options.maxHops ?? MAX_HOPS); hop += 1) {
		await assertFetchable(current, options);
		hops.push(current);

		const response = await ctx.fetch(current, { method: 'HEAD', redirect: 'manual' });
		const location = response.headers.get('location');
		if (response.status >= 300 && response.status < 400 && location !== null) {
			current = new URL(location, current).toString();
			continue;
		}
		if (response.status === 405 || response.status === 501) {
			return { url: current, hops, declared: -1, contentType: '' };
		}
		if (!response.ok) {
			throw new BastionError('usage', `${current} answered ${response.status}`, {
				retryable: response.status >= 500
			});
		}

		const length = response.headers.get('content-length');
		const declared = length === null ? -1 : Number(length);
		if (declared > options.maxBytes) {
			throw new BastionError(
				'usage',
				`${current} is ${declared} bytes, over the ${options.maxBytes} ceiling`,
				{ next: null }
			);
		}
		return {
			url: current,
			hops,
			declared,
			contentType: response.headers.get('content-type') ?? ''
		};
	}

	throw new BastionError(
		'usage',
		`${url} redirects more than ${options.maxHops ?? MAX_HOPS} times`,
		{
			next: null
		}
	);
}

/** reads the body against the ceiling rather than buffering it and measuring afterwards */
async function readCapped(response: Response, url: string, max: number): Promise<Uint8Array> {
	const over = (): never => {
		throw new BastionError('usage', `${url} is over the ${max} byte ceiling`, { next: null });
	};
	const body = response.body;
	if (body === null) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		return bytes.byteLength > max ? over() : bytes;
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done === true) break;
		if (value === undefined) continue;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			over();
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return bytes;
}

export interface Downloaded {
	bytes: Uint8Array;
	source: RemoteSource;
	/** the sha256 of what arrived, recorded whether or not a checksum was demanded */
	digest: string;
}

export async function fetchRemote(
	ctx: Context,
	url: string,
	options: RemoteOptions
): Promise<Downloaded> {
	const source = await probeRemote(ctx, url, options);
	// the chain is already followed and every hop checked, so another one here is a hop nobody saw
	const response = await ctx.fetch(source.url, { redirect: 'error' });
	if (!response.ok) {
		throw new BastionError('usage', `${source.url} answered ${response.status}`, {
			retryable: response.status >= 500
		});
	}

	const bytes = await readCapped(response, source.url, options.maxBytes);
	const digest = createHash('sha256').update(bytes).digest('hex');
	const wanted = (options.checksum ?? '').replace(/^sha256:/i, '').toLowerCase();
	if (wanted !== '' && wanted !== digest) {
		throw new BastionError(
			'usage',
			`${source.url} hashes to sha256:${digest}, not the ${options.checksum} that was asked for`,
			{ next: null }
		);
	}
	return { bytes, source, digest };
}

/** the ceiling on a downloaded bundle; the same figure a template gets, for the same reason */
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

export interface BundleOptions extends Partial<RemoteOptions> {
	/** the directory a downloaded bundle lands in */
	dest: string;
}

/**
 * The last path segment, with everything that could climb out of `dest` removed.
 *
 * Decoded first: `URL.pathname` leaves `%2e%2e%2f` alone, so sanitising before decoding turns a
 * traversal into a plausible-looking filename instead of recognising it as one.
 */
export function bundleName(url: string): string {
	const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
	let decoded = last;
	try {
		decoded = decodeURIComponent(last);
	} catch {
		// a malformed escape is not a name bastion should guess at; the raw form is sanitised below
	}
	// split again after decoding: `a%2fb%2f..%2fp.tgz` carries separators the first split never saw
	const tail = decoded.split('/').filter(Boolean).pop() ?? '';
	const safe = tail.replace(/[^A-Za-z0-9._-]/g, '');
	return safe === '' || safe.startsWith('.') ? 'payload.tar.gz' : safe;
}

/**
 * A local path for a bundle named either as a path or as a url.
 *
 * A path is returned untouched, so nothing about the local case changes. A url is downloaded
 * through the checks above and lands under `dest`, and the config records the file rather than the
 * url: a site whose bundle is re-fetched on every start is a site whose code changes when someone
 * else's server does.
 */
export async function pullBundle(
	ctx: Context,
	source: string,
	options: BundleOptions
): Promise<{ path: string; digest: string | null }> {
	if (!isRemote(source) || source.startsWith('file://')) {
		return { path: source.replace(/^file:\/\//, ''), digest: null };
	}
	const {
		bytes,
		digest,
		source: from
	} = await fetchRemote(ctx, source, {
		maxBytes: MAX_BUNDLE_BYTES,
		...options
	});
	ctx.files.mkdirp(options.dest);
	const path = `${options.dest}/${bundleName(from.url)}`;
	ctx.files.writeBytes(path, bytes);
	return { path, digest };
}
