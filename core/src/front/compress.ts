import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

export interface CompressionPolicy {
	/** in preference order; an encoding absent here is never used even when the client offers it */
	encodings: string[];
	minBytes: number;
}

/** types small enough or already compressed that a second pass costs cpu and saves nothing */
const INCOMPRESSIBLE = [
	'image/',
	'video/',
	'audio/',
	'application/zip',
	'application/gzip',
	'application/wasm',
	'font/woff'
];

export interface Offer {
	encoding: string;
	quality: number;
}

export function parseAcceptEncoding(header: string | null): Offer[] {
	if (header === null) return [];
	return header
		.split(',')
		.map((part) => {
			const [name, ...params] = part.split(';').map((s) => s.trim());
			const q = params.find((p) => p.startsWith('q='));
			const quality = q === undefined ? 1 : Number(q.slice(2));
			return {
				encoding: (name ?? '').toLowerCase(),
				quality: Number.isNaN(quality) ? 0 : quality
			};
		})
		.filter((offer) => offer.encoding !== '' && offer.quality > 0);
}

/**
 * The encoding to answer with, or null for none.
 *
 * Cloudflare negotiates this at the edge and workerd does not do it at all, so terminating TLS
 * here means owning it or shipping every page uncompressed over HTTP/1.1 -- which on a Drupal page
 * pulling thirteen CSS aggregates is a visible regression against the managed product.
 */
export function chooseEncoding(
	accept: string | null,
	contentType: string | null,
	bytes: number,
	policy: CompressionPolicy
): string | null {
	if (bytes < policy.minBytes) return null;
	if (contentType !== null && INCOMPRESSIBLE.some((t) => contentType.startsWith(t))) return null;
	const offers = parseAcceptEncoding(accept);
	let best: { encoding: string; quality: number } | null = null;
	for (const encoding of policy.encodings) {
		const offer = offers.find((o) => o.encoding === encoding);
		if (offer === undefined) continue;
		if (best === null || offer.quality > best.quality)
			best = { encoding, quality: offer.quality };
	}
	return best?.encoding ?? null;
}

export function compress(encoding: string, bytes: Uint8Array): Uint8Array {
	if (encoding === 'gzip') return gzipSync(bytes);
	if (encoding === 'br') {
		return brotliCompressSync(bytes, {
			// 5 rather than the default 11: 11 costs an order of magnitude more cpu for a few
			// percent on html, and the front door is on the hot path of every uncached render
			params: { [constants.BROTLI_PARAM_QUALITY]: 5 }
		});
	}
	throw new Error(`unsupported encoding ${encoding}`);
}
