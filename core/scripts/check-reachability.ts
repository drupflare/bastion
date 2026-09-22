import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MANUAL } from '../../warden/src/manual';
import { IMPLEMENTED } from '../../warden/src/program';
import { defaultConfig } from '../src/config/defaults';
import { CODES } from '../src/errors';
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
	deadNext.length;
if (total === 0) {
	process.stdout.write(
		'reachability: every tripwire has a repair or a button, every config key is read, and ' +
			`every one of the ${IMPLEMENTED.length} commands has a manual section and a ` +
			'dashboard surface or a stated exemption, and every button and next step names a ' +
			'command that exists\n'
	);
	process.exit(0);
}
process.stderr.write(`\n${total} reachability violation${total === 1 ? '' : 's'}\n`);
process.exit(3);
