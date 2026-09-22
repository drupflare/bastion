import type { RemoteOptions } from '@drupflare/bastion';

/** the download flags every command that takes a path-or-url carries, read the same way by each */
export function downloadOptions(globals: {
	checksum?: string;
	insecureSource?: boolean;
}): Partial<RemoteOptions> {
	return {
		...(globals.checksum === undefined ? {} : { checksum: globals.checksum }),
		...(globals.insecureSource === true ? { insecure: true } : {})
	};
}
