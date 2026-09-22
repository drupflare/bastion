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
