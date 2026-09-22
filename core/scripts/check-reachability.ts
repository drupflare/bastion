import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { implementations } from '../../warden/src/api/handlers';
import { MANUAL } from '../../warden/src/manual';
import { HANDLERS, IMPLEMENTED } from '../../warden/src/program';
import { GLOBAL_OPTIONS } from '../../warden/src/registry';
import { ROUTES } from '../src/api/routes';
import { defaultConfig } from '../src/config/defaults';
import { CODES } from '../src/errors';
import { PROBES } from '../src/health/probes';
import { checkTripwires, configKeys, unreadConfigKeys } from '../src/health/reachability';
import { TRIPWIRES } from '../src/health/tripwires';

/**
 * The files that DECLARE the configuration, which are not evidence that anything reads it.
 *
 * Without this the check could not fail: every key is named in its own type and its own defaults,
 * so a key read by nothing still matched itself. Caught by planting one.
 */
const DECLARATIONS = [
	'config/defaults.ts',
	'config/types.ts',
	'config/schema.json',
	'config/validate.ts'
];

function sources(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) sources(path, out);
		else if (path.endsWith('.ts') && !DECLARATIONS.some((d) => path.endsWith(d))) {
			out.push(readFileSync(path, 'utf8'));
		}
	}
	return out;
}

const root = new URL('..', import.meta.url).pathname;
const violations = checkTripwires();
const unread = unreadConfigKeys(configKeys(defaultConfig()), [
	...sources(join(root, 'src')),
	...sources(join(root, '..', 'warden', 'src'))
]);

const topics = new Set(MANUAL.map((section) => section.id));

// the routes the dashboard actually has, read from its pages rather than listed by hand
const pages = readdirSync(join(root, '..', 'dashboard', 'src', 'pages'))
	.filter((entry) => entry.endsWith('.vue'))
	.map((entry) => (entry === 'index.vue' ? '/' : `/${entry.replace(/\.vue$/, '')}`));

// a button or a `next` is only useful if it names a command that exists. `checkTripwires` checks
// the shape of the string; this checks that the program actually has it
const registered = new Set(IMPLEMENTED.map((command) => command.name));
const namesCommand = (text: string | null): string | null => {
	if (text === null || !text.startsWith('bastion ')) return null;
	const words = text
		.slice('bastion '.length)
		.split(' ')
		.filter((word) => !word.startsWith('-'));
	for (let length = Math.min(3, words.length); length > 0; length--) {
		if (registered.has(words.slice(0, length).join(' '))) return null;
	}
	return words.slice(0, 2).join(' ');
};

const deadButtons = TRIPWIRES.map((tripwire) => ({
	source: tripwire.code,
	command: namesCommand(tripwire.button)
})).filter((entry) => entry.command !== null);

/**
 * A tripwire nothing detects, and a detector for a tripwire that does not exist.
 *
 * Both directions, because the second is what catches a code renamed in one table and not the
 * other. This is the rule that would have caught the state this started in: 33 codes, a ledger, a
 * breaker and a repair ladder, with nothing anywhere raising a single one of them.
 */
const probed = new Set(PROBES.map((probe) => probe.code));
const undetected = TRIPWIRES.filter((tripwire) => !probed.has(tripwire.code));
const orphanProbes = PROBES.filter(
	(probe) => !TRIPWIRES.some((tripwire) => tripwire.code === probe.code)
);

/**
 * A management route with no handler, and a handler for a route that does not exist.
 *
 * The rule that would have caught the state this started in: 29 routes, an authz table, sessions,
 * CSRF and API tokens, all shipped and unit-tested, with every single route answering
 * `not-implemented` because nothing ever supplied a handler map. The existing surface rule checks
 * that a command NAMES a dashboard page; it says nothing about whether the route behind it runs.
 */
const shipped = implementations({});
const unhandled = ROUTES.filter((route) => shipped[`${route.method} ${route.path}`] === undefined);
const orphanHandlers = Object.keys(shipped).filter(
	(key) => !ROUTES.some((route) => `${route.method} ${route.path}` === key)
);

// the route table names the CLI command that reaches the same thing, so neither surface can grow
// alone. An exact match rather than a prefix: `version list` is a different command from
// `versions list`, and a prefix match read the first as the second for as long as it was wrong
const misnamedRoutes = ROUTES.filter(
	(route) =>
		!registered.has(
			route.command
				.replace(/^bastion /, '')
				.split(' ')
				.filter((word) => !word.startsWith('-'))
				.join(' ')
		)
);

/**
 * A command flag the program answers itself.
 *
 * `bastion rollout <host> --version <id>` printed `1.0.0` and exited 0, rolling out nothing, for
 * as long as the flag existed: commander resolves `--version` from the program's own version
 * option before the subcommand's. Nothing caught it because the command's spec, its manual entry
 * and its generated documentation all agreed with each other and all described a flag that could
 * not run.
 */
const flagNames = (flags: string) =>
	flags
		.split(/[\s,]+/)
		.filter((token) => token.startsWith('-'))
		.map((token) => token.replace(/[<\[].*$/, ''));

const programFlags = new Set([
	'-V',
	'--version',
	'-h',
	'--help',
	...GLOBAL_OPTIONS.flatMap((option) => flagNames(option.flags))
]);

const shadowed = IMPLEMENTED.flatMap((command) =>
	(command.options ?? []).flatMap((option) =>
		flagNames(option.flags)
			.filter((name) => programFlags.has(name))
			.map((name) => ({ command: command.name, name }))
	)
);

/**
 * A command that reads an argument its own table does not declare.
 *
 * `api token create` took a name in its implementation and declared none, so commander refused
 * `bastion api token create dashboard` with "too many arguments" and every token was called
 * `token`. The two halves live in different files and agreed with nothing.
 */
const underdeclared = IMPLEMENTED.map((command) => {
	const source = String(HANDLERS[command.name] ?? '');
	const indexes = [...source.matchAll(/args\[(\d+)\]/g)].map((match) => Number(match[1]));
	const wanted = indexes.length === 0 ? 0 : Math.max(...indexes) + 1;
	return { command: command.name, wanted, declared: (command.args ?? []).length };
}).filter((entry) => entry.wanted > entry.declared);

const deadNext = Object.entries(CODES)
	.map(([code, entry]) => ({ source: code, command: namesCommand(entry.next) }))
	.filter((entry) => entry.command !== null);

const unsurfaced = IMPLEMENTED.filter((command) => {
	if (command.surface === null || command.surface === undefined) {
		return command.exempt === undefined || command.exempt.trim() === '';
	}
	return !pages.includes(command.surface);
});

const undocumented = IMPLEMENTED.filter((command) => !topics.has(command.manual));

for (const entry of [...deadButtons, ...deadNext]) {
	process.stderr.write(
		`points-at-nothing: ${entry.source} -- names \`bastion ${entry.command}\`, which is not a ` +
			'registered command\n'
	);
}
for (const command of unsurfaced) {
	process.stderr.write(
		`command-unsurfaced: ${command.name} -- names the dashboard route ` +
			`${command.surface ?? '(none)'}, which does not exist, and carries no exemption\n`
	);
}
for (const tripwire of undetected) {
	process.stderr.write(
		`tripwire-undetected: ${tripwire.code} -- no probe raises it, so it can never fire\n`
	);
}
for (const probe of orphanProbes) {
	process.stderr.write(
		`probe-orphaned: ${probe.code} -- detects something no tripwire declares\n`
	);
}
for (const entry of underdeclared) {
	process.stderr.write(
		`arg-undeclared: ${entry.command} -- reads ${entry.wanted} argument(s) and declares ` +
			`${entry.declared}, so the program refuses the ones it never announced\n`
	);
}
for (const entry of shadowed) {
	process.stderr.write(
		`option-shadowed: ${entry.command} -- declares \`${entry.name}\`, which the program ` +
			'declares too, and the program answers first\n'
	);
}
for (const route of unhandled) {
	process.stderr.write(
		`route-unhandled: ${route.method} ${route.path} -- no handler, so it answers ` +
			'not-implemented to every caller\n'
	);
}
for (const key of orphanHandlers) {
	process.stderr.write(
		`handler-orphaned: ${key} -- implements a route the table does not carry\n`
	);
}
for (const route of misnamedRoutes) {
	process.stderr.write(
		`route-misnamed: ${route.method} ${route.path} -- names \`${route.command}\`, ` +
			'which is not a registered command\n'
	);
}
for (const command of undocumented) {
	process.stderr.write(
		`command-undocumented: ${command.name} -- names the manual topic ${command.manual}, ` +
			'which does not exist\n'
	);
}
for (const violation of violations) {
	process.stderr.write(`${violation.rule}: ${violation.subject} -- ${violation.detail}\n`);
}
for (const key of unread) {
	process.stderr.write(`config-unread: ${key} -- nothing in the source reads this key\n`);
}

const total =
	violations.length +
	unread.length +
	undocumented.length +
	unsurfaced.length +
	deadButtons.length +
	deadNext.length +
	undetected.length +
	orphanProbes.length +
	unhandled.length +
	orphanHandlers.length +
	misnamedRoutes.length +
	shadowed.length +
	underdeclared.length;
if (total === 0) {
	process.stdout.write(
		`reachability: every one of the ${TRIPWIRES.length} tripwires has a probe that raises it, ` +
			'a repair or a button, every config key is read, and ' +
			`every one of the ${IMPLEMENTED.length} commands has a manual section and a ` +
			'dashboard surface or a stated exemption, every button and next step names a ' +
			`command that exists, and every one of the ${ROUTES.length} management routes has a ` +
			'handler and names a command\n'
	);
	process.exit(0);
}
process.stderr.write(`\n${total} reachability violation${total === 1 ? '' : 's'}\n`);
process.exit(3);
