/**
 * Escapes a value for a Cap'n Proto text literal.
 *
 * Every path, name and binding value bastion writes into `config.capnp` passes through here.
 * Nothing user-supplied is interpolated raw: a tenant name or a bundle path carrying a quote
 * would otherwise close the literal and inject config into the runtime that serves every other
 * tenant on the box.
 */
export function text(value: string): string {
	let out = '"';
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0;
		switch (char) {
			case '"':
				out += '\\"';
				break;
			case '\\':
				out += '\\\\';
				break;
			case '\n':
				out += '\\n';
				break;
			case '\r':
				out += '\\r';
				break;
			case '\t':
				out += '\\t';
				break;
			default:
				// capnp text is UTF-8; anything below space has no literal form
				out +=
					code < 0x20 || code === 0x7f
						? `\\x${code.toString(16).padStart(2, '0')}`
						: char;
		}
	}
	return `${out}"`;
}

/**
 * A capnp DECLARATION name.
 *
 * camelCase with no underscores, which is a rule of the language rather than a convention:
 * `const w_main :Workerd.Worker` makes the parser report "declaration names should use camelCase
 * and must not contain underscores" and workerd never starts. This is separate from a service's
 * `name = "..."`, which is a string literal and may hold anything.
 */
export function ident(value: string): string {
	if (!/^[a-z][A-Za-z0-9]*$/.test(value)) {
		throw new Error(`\`${value}\` is not a capnp declaration name`);
	}
	return value;
}

/**
 * A declaration name derived from something a user typed, made safe rather than refused.
 *
 * Each run of non-alphanumerics becomes a word boundary and the next letter is capitalised, so
 * `main` is `wMain` and `my-site.edu` is `wMySiteEdu`. A tenant name cannot produce a name the
 * parser rejects, which is what the underscore form did for every configuration bastion generated
 * until a real workerd was finally pointed at one.
 */
export function serviceName(prefix: string, value: string): string {
	const words = value.split(/[^A-Za-z0-9]+/).filter((word) => word !== '');
	const camel = words
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join('')
		.replace(/^[0-9]+/, '');
	return ident(`${prefix}${camel === '' ? 'X' : camel}`);
}
