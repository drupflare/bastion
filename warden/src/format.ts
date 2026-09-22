import { BastionError, parseSize, type Problem } from '@drupflare/bastion';

/** renders a two-column table of label and value, aligned on the label */
export function kv(rows: [string, string][]): string {
	const width = rows.reduce((n, [label]) => Math.max(n, label.length), 0);
	return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}

/** renders a table with a header row */
export function table(headers: string[], rows: string[][]): string {
	const all = [headers, ...rows];
	const widths = headers.map((_, i) => all.reduce((n, r) => Math.max(n, (r[i] ?? '').length), 0));
	const line = (cells: string[]): string =>
		cells
			.map((c, i) => c.padEnd(widths[i] ?? 0))
			.join('  ')
			.trimEnd();
	return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** yes/no, so a report never prints `true` at an operator */
export function yesNo(value: boolean): string {
	return value ? 'yes' : 'no';
}

/**
 * Reads a size the way the validator does, and refuses what it cannot read.
 *
 * `--memory 4Gi` is the value the manual and the README both use, and `Number('4Gi')` is `NaN`.
 * That NaN reached the configuration, then `String(NaN)` reached the kernel, and the cgroup write
 * failed with EINVAL during startup. The tenant ran with no memory limit at all while
 * `tenant list` printed `NaN` in the column that was supposed to prove it had one.
 */
export function sizeOrRefuse(raw: string): number {
	const problems: Problem[] = [];
	const parsed = parseSize(raw, 'memory', problems);
	if (parsed === null || problems.length > 0) {
		throw new BastionError('usage', `\`${raw}\` is not a size such as 512Mi or 4Gi`, {
			next: null
		});
	}
	return parsed;
}
