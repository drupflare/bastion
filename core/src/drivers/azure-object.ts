import { createHmac } from 'node:crypto';
import { capabilities } from '../adapters/capabilities';
import { assertComplete, type ObjectMeta, type ObjectStore } from '../adapters/objects';
import type { Context } from '../context';
import { BastionError } from '../errors';

export interface AzureOptions {
	account: string;
	/** the base64 account key; a SAS token is a different scheme and is not this driver */
	accountKey: string;
	container: string;
	endpoint?: string;
}

const VERSION = '2021-12-02';

/**
 * Azure's SharedKey string to sign.
 *
 * Positional and unforgiving: every header has a line whether or not it is set, `Content-Length`
 * is EMPTY rather than `0` for a request with no body, and the x-ms headers are sorted. It is
 * written out in full rather than assembled in a loop because a missing newline here fails as an
 * authentication error, which reads like a wrong key.
 */
export function sharedKeyStringToSign(
	method: string,
	url: URL,
	headers: Record<string, string>,
	account: string,
	contentLength: number
): string {
	const get = (name: string): string => headers[name] ?? headers[name.toLowerCase()] ?? '';
	const msHeaders = Object.entries(headers)
		.filter(([k]) => k.toLowerCase().startsWith('x-ms-'))
		.map(([k, v]) => [k.toLowerCase(), v.trim()] as [string, string])
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([k, v]) => `${k}:${v}`)
		.join('\n');
	const query = [...url.searchParams.keys()]
		.sort()
		.map((k) => `${k.toLowerCase()}:${url.searchParams.getAll(k).sort().join(',')}`)
		.join('\n');
	const resource = `/${account}${url.pathname}${query === '' ? '' : `\n${query}`}`;
	return [
		method.toUpperCase(),
		get('content-encoding'),
		get('content-language'),
		contentLength === 0 ? '' : String(contentLength),
		get('content-md5'),
		get('content-type'),
		get('date'),
		get('if-modified-since'),
		get('if-match'),
		get('if-none-match'),
		get('if-unmodified-since'),
		get('range'),
		msHeaders,
		resource
	].join('\n');
}

export function azureObjectStore(ctx: Context, options: AzureOptions): ObjectStore {
	const base = options.endpoint ?? `https://${options.account}.blob.core.windows.net`;
	let unreachable: string | null = null;

	const sign = (
		method: string,
		url: URL,
		headers: Record<string, string>,
		length: number
	): string => {
		const toSign = sharedKeyStringToSign(method, url, headers, options.account, length);
		const signature = createHmac('sha256', Buffer.from(options.accountKey, 'base64'))
			.update(toSign, 'utf8')
			.digest('base64');
		return `SharedKey ${options.account}:${signature}`;
	};

	const call = async (
		method: string,
		url: URL,
		body: Uint8Array | null,
		extra: Record<string, string> = {}
	): Promise<Response> => {
		const headers: Record<string, string> = {
			'x-ms-version': VERSION,
			'x-ms-date': new Date(ctx.now()).toUTCString(),
			...extra
		};
		headers.authorization = sign(method, url, headers, body?.length ?? 0);
		try {
			const response = await ctx.fetch(url.toString(), {
				method,
				headers,
				...(body === null ? {} : { body })
			});
			unreachable = response.status >= 500 ? `${response.status} from azure` : null;
			return response;
		} catch (e) {
			unreachable = e instanceof Error ? e.message : String(e);
			throw e;
		}
	};

	const urlFor = (key: string, query: Record<string, string> = {}): URL => {
		const url = new URL(`${base}/${options.container}/${key}`);
		for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
		return url;
	};

	const metaFrom = (key: string, response: Response): ObjectMeta => ({
		key,
		size: Number(response.headers.get('content-length') ?? 0),
		etag: response.headers.get('etag') ?? '',
		uploadedAt: Date.parse(response.headers.get('last-modified') ?? '') || 0
	});

	return {
		id: () => 'azure',
		label: () => `Azure Blob (${options.account}/${options.container})`,
		capabilities: () =>
			capabilities({
				conditionalWrite: true,
				byteRange: true,
				pagedList: true,
				maxValueBytes: 256 * 1024 * 1024
			}),
		isReachable: async () => {
			try {
				const response = await call(
					'GET',
					urlFor('', { restype: 'container', comp: 'list', maxresults: '1' }),
					null
				);
				return response.ok;
			} catch {
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
			assertComplete(
				'azure',
				key,
				Number(response.headers.get('content-length') ?? bytes.length),
				bytes.length
			);
			return { bytes, meta: { ...metaFrom(key, response), size: bytes.length } };
		},

		put: async (key, bytes, putOptions) => {
			const extra: Record<string, string> = { 'x-ms-blob-type': 'BlockBlob' };
			if (putOptions?.ifAbsent === true) extra['if-none-match'] = '*';
			for (const [name, value] of Object.entries(putOptions?.customMetadata ?? {})) {
				extra[`x-ms-meta-${name}`] = value;
			}
			const response = await call('PUT', urlFor(key), bytes, extra);
			if (response.status === 409 || response.status === 412) {
				throw new BastionError('driver-refused', `${key} already exists`);
			}
			if (!response.ok)
				throw new BastionError('driver-unreachable', `PUT ${key}: ${response.status}`);
			return {
				key,
				size: bytes.length,
				etag: response.headers.get('etag') ?? '',
				uploadedAt: ctx.now()
			};
		},

		delete: async (keys) => {
			let removed = 0;
			for (const key of keys) {
				const response = await call('DELETE', urlFor(key), null);
				if (response.ok || response.status === 404 || response.status === 202) removed++;
			}
			return removed;
		},

		list: async (prefix = '', cursor = null, limit = 1000) => {
			const query: Record<string, string> = {
				restype: 'container',
				comp: 'list',
				maxresults: String(limit)
			};
			if (prefix !== '') query.prefix = prefix;
			if (cursor !== null) query.marker = cursor;
			const response = await call('GET', urlFor('', query), null);
			if (!response.ok)
				throw new BastionError('driver-unreachable', `LIST: ${response.status}`);
			const xml = await response.text();
			const objects: ObjectMeta[] = [];
			let at = 0;
			for (;;) {
				const open = xml.indexOf('<Blob>', at);
				if (open === -1) break;
				const close = xml.indexOf('</Blob>', open);
				const block = xml.slice(open, close === -1 ? undefined : close);
				const name = /<Name>([^<]*)<\/Name>/.exec(block)?.[1];
				if (name !== undefined) {
					objects.push({
						key: name,
						size: Number(
							/<Content-Length>([^<]*)<\/Content-Length>/.exec(block)?.[1] ?? 0
						),
						etag: /<Etag>([^<]*)<\/Etag>/.exec(block)?.[1] ?? '',
						uploadedAt:
							Date.parse(
								/<Last-Modified>([^<]*)<\/Last-Modified>/.exec(block)?.[1] ?? ''
							) || 0
					});
				}
				at = close === -1 ? xml.length : close + 1;
			}
			const marker = /<NextMarker>([^<]*)<\/NextMarker>/.exec(xml)?.[1] ?? '';
			return { objects, cursor: marker === '' ? null : marker };
		}
	};
}
