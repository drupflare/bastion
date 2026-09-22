/**
 * Image transformation, run natively.
 *
 * `@gmitch215/tinyimg` solved this inside a Worker, where there is no Canvas, no
 * `createImageBitmap` and a wasm32 address space to fit the decoder, the pixels and the encoder
 * into at once. bastion is an ordinary native process, so none of those bound it: a transform runs
 * against the host's own image tooling with the host's memory, and a 40 megapixel source is a
 * question about the box rather than about the runtime.
 *
 * **Off unless the operator turns it on.** ImageMagick is not preinstalled on a server image:
 * Debian, Ubuntu, RHEL and Alpine all ship without it, so `magick` is something an operator
 * installs on purpose. bastion never installs it, never falls back to a different tool, and
 * refuses a site that binds Images while `drivers.images` is unset rather than accepting the
 * configuration and failing on the first upload.
 */

import type { Context } from '../context';
import { BastionError } from '../errors';

export interface TransformOptions {
	width?: number;
	height?: number;
	fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
	gravity?: string;
	rotate?: number;
	blur?: number;
	sharpen?: number;
	brightness?: number;
	contrast?: number;
	gamma?: number;
	background?: string;
	trim?: boolean;
}

export interface OutputOptions {
	format?: string;
	quality?: number;
}

export interface ImagePipeline {
	ops: { op: 'transform' | 'draw'; options: TransformOptions }[];
	output: OutputOptions;
}

export interface ImageInfo {
	format: string;
	width: number;
	height: number;
	fileSize: number;
}

export interface ImageStore {
	id(): string;
	info(bytes: Uint8Array): Promise<ImageInfo>;
	transform(
		bytes: Uint8Array,
		pipeline: ImagePipeline
	): Promise<{ bytes: Uint8Array; contentType: string }>;
	isReachable(): Promise<boolean>;
}

/** what a browser will actually render, which is the only reason to encode into a format */
export const IMAGE_TYPES: Record<string, string> = {
	avif: 'image/avif',
	webp: 'image/webp',
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif'
};

export function contentTypeFor(format: string | undefined): string {
	if (format === undefined) return 'image/jpeg';
	const clean = format.replace(/^image\//, '').toLowerCase();
	const type = IMAGE_TYPES[clean];
	if (type === undefined) {
		throw new BastionError('usage', `bastion does not encode ${format}`, { next: null });
	}
	return type;
}

/**
 * Reads the format and dimensions out of the header bytes.
 *
 * Done here rather than by shelling out because `info` is the call a resizing worker makes on
 * every request to decide whether to transform at all, and spawning a process to read eight bytes
 * would cost more than the transform it is trying to avoid.
 */
export function readHeader(bytes: Uint8Array): ImageInfo | null {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const size = bytes.byteLength;

	if (size > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
		return {
			format: 'png',
			width: view.getUint32(16),
			height: view.getUint32(20),
			fileSize: size
		};
	}
	if (size > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
		return {
			format: 'gif',
			width: view.getUint16(6, true),
			height: view.getUint16(8, true),
			fileSize: size
		};
	}
	if (size > 30 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42) {
		// VP8X carries the canvas size as two 24-bit values, minus one, at offset 24
		if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
			const w =
				((bytes[24] as number) |
					((bytes[25] as number) << 8) |
					((bytes[26] as number) << 16)) +
				1;
			const h =
				((bytes[27] as number) |
					((bytes[28] as number) << 8) |
					((bytes[29] as number) << 16)) +
				1;
			return { format: 'webp', width: w, height: h, fileSize: size };
		}
		return { format: 'webp', width: 0, height: 0, fileSize: size };
	}
	if (size > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		// walk the segment chain to SOF, because a jpeg carries its size nowhere fixed
		let offset = 2;
		while (offset + 9 < size) {
			if (bytes[offset] !== 0xff) break;
			const marker = bytes[offset + 1] as number;
			const length = view.getUint16(offset + 2);
			// every SOF except the DHT/DAC/DNL markers that share the range
			if (
				marker >= 0xc0 &&
				marker <= 0xcf &&
				marker !== 0xc4 &&
				marker !== 0xc8 &&
				marker !== 0xcc
			) {
				return {
					format: 'jpeg',
					height: view.getUint16(offset + 5),
					width: view.getUint16(offset + 7),
					fileSize: size
				};
			}
			offset += 2 + length;
		}
		return { format: 'jpeg', width: 0, height: 0, fileSize: size };
	}
	return null;
}

export interface CommandImageOptions {
	/** the binary that does the work; `magick` on imagemagick 7, `convert` on 6, `vipsthumbnail` */
	command?: string;
	/** a ceiling on the source, because a decoder allocates from the header before reading pixels */
	maxBytes?: number;
	/** where the source and the result are staged; both are removed afterwards */
	scratch?: string;
}

/** 20 MB, matching what the Cloudflare binding accepts, so a bundle's own guard still lines up */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Builds the argument list for one pipeline.
 *
 * `execFile` with an array, never a shell, and every value is a number or a checked enum before it
 * becomes an argument. A geometry string assembled from an unchecked width is the shape that turns
 * a query parameter into an argument to the host's image library.
 */
export function magickArgs(pipeline: ImagePipeline, from = '-', to?: string): string[] {
	const args = [from];
	for (const step of pipeline.ops) {
		if (step.op !== 'transform') continue;
		const o = step.options;
		if (o.trim === true) args.push('-trim', '+repage');
		if (o.width !== undefined || o.height !== undefined) {
			const w = o.width === undefined ? '' : String(Math.max(1, Math.round(o.width)));
			const h = o.height === undefined ? '' : String(Math.max(1, Math.round(o.height)));
			const geometry = `${w}x${h}`;
			if (o.fit === 'cover' || o.fit === 'crop') {
				args.push(
					'-resize',
					`${geometry}^`,
					'-gravity',
					gravityOf(o.gravity),
					'-extent',
					geometry
				);
			} else if (o.fit === 'pad') {
				args.push(
					'-resize',
					geometry,
					'-background',
					colourOf(o.background),
					'-gravity',
					gravityOf(o.gravity),
					'-extent',
					geometry
				);
			} else if (o.fit === 'scale-down') {
				// `>` only shrinks, which is what scale-down means and what a plain resize does not
				args.push('-resize', `${geometry}>`);
			} else {
				args.push('-resize', geometry);
			}
		}
		if (o.rotate !== undefined) args.push('-rotate', String(Math.round(o.rotate)));
		if (o.blur !== undefined) args.push('-blur', `0x${clamp(o.blur, 0, 250)}`);
		if (o.sharpen !== undefined) args.push('-sharpen', `0x${clamp(o.sharpen, 0, 10)}`);
		if (o.brightness !== undefined || o.contrast !== undefined) {
			args.push(
				'-brightness-contrast',
				`${clamp((o.brightness ?? 1) * 100 - 100, -100, 100)}x${clamp((o.contrast ?? 1) * 100 - 100, -100, 100)}`
			);
		}
		if (o.gamma !== undefined) args.push('-gamma', String(clamp(o.gamma, 0.1, 10)));
	}
	if (pipeline.output.quality !== undefined) {
		args.push('-quality', String(clamp(pipeline.output.quality, 1, 100)));
	}
	// strip metadata: an exif block carries gps coordinates and a camera serial, and a site
	// resizing a user upload should not be republishing either
	args.push('-strip');
	const format = (pipeline.output.format ?? 'jpeg').replace(/^image\//, '').toLowerCase();
	contentTypeFor(format);
	args.push(`${format}:${to ?? '-'}`);
	return args;
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
}

const GRAVITIES: Record<string, string> = {
	auto: 'Center',
	center: 'Center',
	left: 'West',
	right: 'East',
	top: 'North',
	bottom: 'South'
};

function gravityOf(value: string | undefined): string {
	return GRAVITIES[(value ?? 'center').toLowerCase()] ?? 'Center';
}

function colourOf(value: string | undefined): string {
	if (value === undefined) return 'none';
	// a colour reaches the host's parser, so only the two forms bastion can check itself pass
	if (/^#[0-9a-fA-F]{3,8}$/.test(value) || /^[a-zA-Z]{3,20}$/.test(value)) return value;
	throw new BastionError('usage', `${value} is not a colour bastion will pass through`, {
		next: null
	});
}

/**
 * A driver over an image tool the operator installed.
 *
 * `magick` is the default name rather than the assumed one: ImageMagick 7 calls itself that, 6
 * calls itself `convert`, and neither is present until somebody installs it. The contract is
 * structural, so an operator running libvips supplies their own `ImageStore` and bastion depends
 * on nothing.
 */
export function commandImages(ctx: Context, options: CommandImageOptions = {}): ImageStore {
	const command = options.command ?? 'magick';
	const ceiling = options.maxBytes ?? MAX_IMAGE_BYTES;

	return {
		id: () => command,
		isReachable: async () => {
			try {
				return (await ctx.runner.run(command, ['-version'])).code === 0;
			} catch {
				return false;
			}
		},
		info: async (bytes) => {
			const header = readHeader(bytes);
			if (header !== null) return header;
			throw new BastionError('usage', 'that is not an image bastion recognises', {
				next: null
			});
		},
		transform: async (bytes, pipeline) => {
			if (bytes.byteLength > ceiling) {
				throw new BastionError(
					'usage',
					`the source is ${bytes.byteLength} bytes, over the ${ceiling} ceiling`,
					{ next: null }
				);
			}
			if (readHeader(bytes) === null) {
				throw new BastionError('usage', 'that is not an image bastion recognises', {
					next: null
				});
			}
			// staged through files rather than through the runner: that seam carries text, and an
			// encoded image round-tripped as a string comes back as replacement characters
			const scratch = options.scratch ?? '/tmp/bastion-images';
			const stamp = `${ctx.now()}-${Math.random().toString(36).slice(2, 10)}`;
			const from = `${scratch}/${stamp}.in`;
			const to = `${scratch}/${stamp}.out`;
			ctx.files.mkdirp(scratch);
			ctx.files.writeBytes(from, bytes);
			try {
				const result = await ctx.runner.run(command, magickArgs(pipeline, from, to));
				if (result.code !== 0 || !ctx.files.exists(to)) {
					throw new BastionError(
						'driver-refused',
						`the image tool failed: ${result.stderr}`,
						{ next: null }
					);
				}
				return {
					bytes: ctx.files.readBytes(to),
					contentType: contentTypeFor(pipeline.output.format)
				};
			} finally {
				ctx.files.remove(from);
				ctx.files.remove(to);
			}
		}
	};
}
