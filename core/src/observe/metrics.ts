export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface MetricLabels {
	node?: string;
	tenant?: string;
	site?: string;
	[key: string]: string | undefined;
}

interface Series {
	name: string;
	kind: MetricKind;
	help: string;
	labels: MetricLabels;
	value: number;
	/** histogram only */
	buckets?: Map<number, number>;
	sum?: number;
	count?: number;
}

function labelKey(labels: MetricLabels): string {
	return Object.entries(labels)
		.filter(([, value]) => value !== undefined)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, value]) => `${name}="${String(value).replace(/["\\\n]/g, '')}"`)
		.join(',');
}

export const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

/**
 * The Prometheus registry.
 *
 * **Every series carries a `tenant` label and, where it means anything, a `site` one.** Requests,
 * CPU, storage bytes and rows written are the billing inputs a control plane needs; adding the
 * label now costs one line, and adding it later is a migration across every series already
 * recorded.
 */
export class Registry {
	private readonly series = new Map<string, Series>();
	private readonly node: string;

	constructor(node = 'local') {
		this.node = node;
	}

	private key(name: string, labels: MetricLabels): string {
		return `${name}{${labelKey({ node: this.node, ...labels })}}`;
	}

	private upsert(name: string, kind: MetricKind, help: string, labels: MetricLabels): Series {
		const key = this.key(name, labels);
		const existing = this.series.get(key);
		if (existing !== undefined) return existing;
		const created: Series = {
			name,
			kind,
			help,
			labels: { node: this.node, ...labels },
			value: 0,
			...(kind === 'histogram'
				? { buckets: new Map(DEFAULT_BUCKETS.map((b) => [b, 0])), sum: 0, count: 0 }
				: {})
		};
		this.series.set(key, created);
		return created;
	}

	counter(name: string, help: string, labels: MetricLabels = {}, by = 1): void {
		this.upsert(name, 'counter', help, labels).value += by;
	}

	gauge(name: string, help: string, value: number, labels: MetricLabels = {}): void {
		this.upsert(name, 'gauge', help, labels).value = value;
	}

	observe(name: string, help: string, value: number, labels: MetricLabels = {}): void {
		const series = this.upsert(name, 'histogram', help, labels);
		series.sum = (series.sum ?? 0) + value;
		series.count = (series.count ?? 0) + 1;
		for (const bound of DEFAULT_BUCKETS) {
			if (value <= bound) series.buckets?.set(bound, (series.buckets.get(bound) ?? 0) + 1);
		}
	}

	get size(): number {
		return this.series.size;
	}

	/** the text exposition format, which is the only thing Prometheus reads */
	render(): string {
		const byName = new Map<string, Series[]>();
		for (const series of this.series.values()) {
			byName.set(series.name, [...(byName.get(series.name) ?? []), series]);
		}
		const lines: string[] = [];
		for (const [name, group] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
			const first = group[0] as Series;
			lines.push(`# HELP ${name} ${first.help}`);
			lines.push(`# TYPE ${name} ${first.kind}`);
			for (const series of group) {
				const labels = labelKey(series.labels);
				if (series.kind === 'histogram') {
					for (const [bound, count] of series.buckets ?? []) {
						lines.push(`${name}_bucket{${labels},le="${bound}"} ${count}`);
					}
					lines.push(`${name}_bucket{${labels},le="+Inf"} ${series.count ?? 0}`);
					lines.push(`${name}_sum{${labels}} ${series.sum ?? 0}`);
					lines.push(`${name}_count{${labels}} ${series.count ?? 0}`);
					continue;
				}
				lines.push(
					labels === '' ? `${name} ${series.value}` : `${name}{${labels}} ${series.value}`
				);
			}
		}
		return `${lines.join('\n')}\n`;
	}

	/**
	 * Merges another node's exposition into this one.
	 *
	 * The control node exposes a federated view; each series keeps the `node` label it arrived
	 * with, so a query can still separate them.
	 */
	static federate(parts: string[]): string {
		const seen = new Set<string>();
		const lines: string[] = [];
		for (const part of parts) {
			for (const line of part.split('\n')) {
				if (line.trim() === '') continue;
				if (line.startsWith('#')) {
					if (seen.has(line)) continue;
					seen.add(line);
				}
				lines.push(line);
			}
		}
		return `${lines.join('\n')}\n`;
	}
}
