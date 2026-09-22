export interface CaaRecord {
	critical: number;
	tag: string;
	value: string;
}

/**
 * The DNS seam.
 *
 * Every lookup bastion makes goes through this, so the gate lane answers from a fixture and no
 * spec resolves a real name. A domain check that only works with a network is a check nobody runs.
 */
export interface DnsResolver {
	txt(name: string): Promise<string[]>;
	a(name: string): Promise<string[]>;
	aaaa(name: string): Promise<string[]>;
	caa(name: string): Promise<CaaRecord[]>;
	cname(name: string): Promise<string[]>;
}

export class DnsError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/** `NXDOMAIN` and `ENODATA` are answers, not failures; everything else is a resolver problem */
export function isAbsent(error: unknown): boolean {
	const code = (error as { code?: string })?.code ?? '';
	return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN';
}

export function nodeResolver(): DnsResolver {
	const load = async () => (await import('node:dns/promises')).Resolver;

	const lookup = async <T>(
		run: (resolver: InstanceType<Awaited<ReturnType<typeof load>>>) => Promise<T>,
		empty: T
	): Promise<T> => {
		const Resolver = await load();
		const resolver = new Resolver();
		try {
			return await run(resolver as InstanceType<typeof Resolver>);
		} catch (error) {
			if (isAbsent(error)) return empty;
			throw new DnsError(
				(error as { code?: string })?.code ?? 'dns-failed',
				`the resolver could not answer: ${(error as Error).message}`
			);
		}
	};

	return {
		txt: (name) =>
			lookup(async (r) => (await r.resolveTxt(name)).map((parts) => parts.join('')), []),
		a: (name) => lookup((r) => r.resolve4(name), []),
		aaaa: (name) => lookup((r) => r.resolve6(name), []),
		cname: (name) => lookup((r) => r.resolveCname(name), []),
		caa: (name) =>
			lookup(
				async (r) =>
					(await r.resolveCaa(name)).map((record) => {
						const entry = record as unknown as Record<string, string | number>;
						const tag =
							['issue', 'issuewild', 'iodef'].find((key) => key in entry) ?? '';
						return {
							critical: Number(entry.critical ?? 0),
							tag,
							value: String(entry[tag] ?? '')
						};
					}),
				[]
			)
	};
}

/** answers from a fixture; the gate lane never resolves a real name */
export function fixtureResolver(
	records: Partial<Record<keyof DnsResolver, Record<string, string[] | CaaRecord[]>>> = {}
): DnsResolver {
	const read = <T>(kind: keyof DnsResolver, name: string): T[] =>
		(records[kind]?.[name] ?? []) as T[];
	return {
		txt: async (name) => read<string>('txt', name),
		a: async (name) => read<string>('a', name),
		aaaa: async (name) => read<string>('aaaa', name),
		cname: async (name) => read<string>('cname', name),
		caa: async (name) => read<CaaRecord>('caa', name)
	};
}
