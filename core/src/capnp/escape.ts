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

/** a capnp identifier; refuses rather than escaping, because a service name is ours to choose */
export function ident(value: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
		throw new Error(`\`${value}\` is not a capnp identifier`);
	}
	return value;
}

/** a service name derived from something a user typed, made safe rather than refused */
export function serviceName(prefix: string, value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
	return ident(`${prefix}_${cleaned === '' ? 'x' : cleaned}`);
}
