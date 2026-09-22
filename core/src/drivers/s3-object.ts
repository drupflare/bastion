import { capabilities } from '../adapters/capabilities';
import {
	assertComplete,
	type ObjectMeta,
	type ObjectStore,
	type PutObjectOptions
} from '../adapters/objects';
import type { Context } from '../context';
import { BastionError } from '../errors';
import { signRequest, uriEncode, type SigningCredentials } from './sigv4';

export interface S3Options {
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	region?: string;
	/** the base endpoint; defaults per flavour */
	endpoint?: string;
	/** `path` puts the bucket in the path, which is what minio and r2 want */
	addressing?: 'path' | 'virtual';
}

/**
 * Endpoint defaults per flavour.
 *
 * All five speak the same protocol, so they are one driver with five ids rather than five drivers.
 * GCS is its interoperability mode, which takes HMAC keys and answers the S3 XML API; a service
 * account JSON key is a different auth scheme and is not this driver.
 */
export const S3_FLAVOURS: Record<
	string,
	{ endpoint?: string; region: string; addressing: 'path' | 'virtual' }
> = {
	s3: { region: 'us-east-1', addressing: 'virtual' },
	r2: { region: 'auto', addressing: 'path' },
	b2: {
		endpoint: 'https://s3.us-west-004.backblazeb2.com',
		region: 'us-west-004',
		addressing: 'path'
	},
	gcs: { endpoint: 'https://storage.googleapis.com', region: 'auto', addressing: 'path' },
	minio: { endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', addressing: 'path' }
};

function textBetween(xml: string, tag: string, from = 0): { value: string; end: number } | null {
	const open = xml.indexOf(`<${tag}>`, from);
	if (open === -1) return null;
	const close = xml.indexOf(`</${tag}>`, open);
	if (close === -1) return null;
	return { value: xml.slice(open + tag.length + 2, close), end: close };
}

/** the subset of ListObjectsV2 bastion reads, parsed without an XML dependency */
export function parseListing(xml: string): { objects: ObjectMeta[]; cursor: string | null } {
	const objects: ObjectMeta[] = [];
	let at = 0;
	for (;;) {
		const open = xml.indexOf('<Contents>', at);
		if (open === -1) break;
		const close = xml.indexOf('</Contents>', open);
		const block = xml.slice(open, close === -1 ? undefined : close);
		const key = textBetween(block, 'Key')?.value;
		if (key !== undefined) {
			objects.push({
				key,
				size: Number(textBetween(block, 'Size')?.value ?? 0),
				etag: textBetween(block, 'ETag')?.value ?? '',
				uploadedAt: Date.parse(textBetween(block, 'LastModified')?.value ?? '') || 0
			});
		}
		at = close === -1 ? xml.length : close + 1;
	}
	const truncated = textBetween(xml, 'IsTruncated')?.value === 'true';
	const next = textBetween(xml, 'NextContinuationToken')?.value ?? null;
	return { objects, cursor: truncated ? next : null };
}

/**
 * Objects over the S3 protocol.
 *
 * `fetch` is the only transport, so there is no SDK to keep current and no credential-resolution
 * chain reading a file bastion never asked for. Everything the endpoint could do beyond the
 * contract stays unused: the point of the contract is that the engine branches on a capability
 * rather than on which of these five it is talking to.
 */
export function s3ObjectStore(ctx: Context, flavour: string, options: S3Options): ObjectStore {
	const defaults = S3_FLAVOURS[flavour];
	if (defaults === undefined) {
		throw new BastionError('driver-refused', `unknown object driver ${flavour}`);
	}
	const endpoint = options.endpoint ?? defaults.endpoint;
	if (endpoint === undefined && flavour !== 's3') {
		throw new BastionError('driver-refused', `the ${flavour} driver needs an endpoint`);
	}
	const base = endpoint ?? `https://s3.${options.region ?? defaults.region}.amazonaws.com`;
	const addressing = options.addressing ?? defaults.addressing;
	const credentials: SigningCredentials = {
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey,
		...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
		region: options.region ?? defaults.region,
		service: 's3'
	};
	let unreachable: string | null = null;

	const urlFor = (key: string, query: Record<string, string> = {}): URL => {
		const root = new URL(base);
		// encoded here rather than left to `new URL`, which leaves `+`, `=` and `*` raw in a path
		const path = uriEncode(key, true);
		const url =
			addressing === 'path'
				? new URL(
						`${root.origin}${root.pathname.replace(/\/$/, '')}/${options.bucket}/${path}`
					)
				: new URL(`${root.protocol}//${options.bucket}.${root.host}/${path}`);
		for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
		return url;
	};

	const call = async (
		method: string,
		url: URL,
		body: Uint8Array | null,
		extra: Record<string, string> = {}
	): Promise<Response> => {
		const signed = signRequest(method, url, extra, body, credentials, ctx.now());
		const response = await ctx.fetch(url.toString(), {
			method,
			headers: signed.headers,
			...(body === null ? {} : { body })
		});
		if (response.status >= 500) unreachable = `${response.status} from ${url.host}`;
		else unreachable = null;
		return response;
	};

	const metaFrom = (key: string, response: Response): ObjectMeta => {
		const custom: Record<string, string> = {};
		response.headers.forEach((value, name) => {
			if (name.toLowerCase().startsWith('x-amz-meta-')) custom[name.slice(11)] = value;
		});
		return {
			key,
			size: Number(response.headers.get('content-length') ?? 0),
			etag: response.headers.get('etag') ?? '',
			uploadedAt: Date.parse(response.headers.get('last-modified') ?? '') || 0,
			...(Object.keys(custom).length === 0 ? {} : { customMetadata: custom })
		};
	};

	return {
		id: () => flavour,
		label: () => `${flavour} (${options.bucket})`,
		capabilities: () =>
			capabilities({
				conditionalWrite: true,
				byteRange: true,
				batchDelete: false,
				pagedList: true,
				maxValueBytes: 5 * 1024 * 1024 * 1024
			}),
		isReachable: async () => {
			try {
				const response = await call(
					'GET',
					urlFor('', { 'list-type': '2', 'max-keys': '1' }),
					null
				);
				return response.ok;
			} catch (e) {
				unreachable = e instanceof Error ? e.message : String(e);
				return false;
			}
		},
		unreachableReason: () => unreachable,

		head: async (key) => {
			const response = await call('HEAD', urlFor(key), null);
			if (response.status === 404) return null;
			if (!response.ok)
				throw new BastionError('driver-unreachable', `HEAD ${key}: ${response.status}`);
			return metaFrom(key, response);
		},

		get: async (key, range) => {
			const extra: Record<string, string> = {};
			if (range !== undefined) {
				extra.range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
			}
			const response = await call('GET', urlFor(key), null, extra);
			if (response.status === 404) return null;
			if (!response.ok)
				throw new BastionError('driver-unreachable', `GET ${key}: ${response.status}`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			const declared = Number(response.headers.get('content-length') ?? bytes.length);
			assertComplete(flavour, key, declared, bytes.length);
			return { bytes, meta: { ...metaFrom(key, response), size: bytes.length } };
		},

		put: async (key, bytes, options: PutObjectOptions = {}) => {
			const extra: Record<string, string> = {};
			if (options.ifAbsent === true) extra['if-none-match'] = '*';
			for (const [name, value] of Object.entries(options.customMetadata ?? {})) {
				extra[`x-amz-meta-${name}`] = value;
			}
			for (const [name, value] of Object.entries(options.httpMetadata ?? {})) {
				extra[name.toLowerCase()] = value;
			}
			const response = await call('PUT', urlFor(key), bytes, extra);
			if (response.status === 412) {
				throw new BastionError('driver-refused', `${key} already exists`);
			}
			if (!response.ok)
				throw new BastionError('driver-unreachable', `PUT ${key}: ${response.status}`);
			return {
				key,
				size: bytes.length,
				etag: response.headers.get('etag') ?? '',
				uploadedAt: ctx.now(),
				...(options.customMetadata === undefined
					? {}
					: { customMetadata: options.customMetadata })
			};
		},

		delete: async (keys) => {
			let removed = 0;
			for (const key of keys) {
				const response = await call('DELETE', urlFor(key), null);
				if (response.ok || response.status === 404) removed++;
			}
			return removed;
		},

		list: async (prefix = '', cursor = null, limit = 1000) => {
			const query: Record<string, string> = {
				'list-type': '2',
				'max-keys': String(limit)
			};
			if (prefix !== '') query.prefix = prefix;
			if (cursor !== null) query['continuation-token'] = cursor;
			const response = await call('GET', urlFor('', query), null);
			if (!response.ok)
				throw new BastionError('driver-unreachable', `LIST: ${response.status}`);
			return parseListing(await response.text());
		}
	};
}
