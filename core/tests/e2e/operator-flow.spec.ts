import { execFile } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { gate } from './support/gate';

/**
 * The commands an IT director actually types, against the compiled binary.
 *
 * Not the library: the binary, because that is what ships and because several things only exist
 * there. `bastion up` spawns `process.execPath serve`, which is the binary itself when compiled
 * and is the bun runtime when the CLI runs from source, so this path cannot be exercised any
 * other way.
 *
 * The flow is the one a first install follows and the order matters: nothing here sets up state
 * behind the command under test. A failure late in the list means the commands before it left the
 * box in a shape the next one could not use, which is the class of defect a per-command unit test
 * cannot see.
 */
const run = promisify(execFile);

const binary = process.env.BASTION_BINARY ?? '';
const workerd = process.env.WORKERD_BINARY ?? '';

/**
 * Skips only when nobody asked for this lane; refuses when they did and it cannot run.
 *
 * `REQUIRE_FLOW=1` means this MUST run. Answering a missing prerequisite with a skip reports
 * success, which is exactly how the workerd boot stayed unexercised through the whole build.
 */
const reason = gate('REQUIRE_FLOW', [
	{
		what: `BASTION_BINARY (${binary}) is not a file`,
		present: binary !== '' && existsSync(binary)
	},
	{
		what: `WORKERD_BINARY (${workerd}) is not a file`,
		present: workerd !== '' && existsSync(workerd)
	}
]);

/** the pin `bastion init` writes, which decides where the runtime has to be staged */
const PINNED = '1.20260828.1';

interface Outcome {
	code: number;
	stdout: string;
	stderr: string;
}

describe.skipIf(reason !== null)(`operator flow (${reason ?? 'enabled'})`, () => {
	const root = mkdtempSync(join(tmpdir(), 'bastion-flow-'));
	const config = join(root, 'bastion.yml');
	const state = join(root, 'state');

	/** every invocation carries --config, so nothing reaches a real /etc/bastion */
	async function bastion(...argv: string[]): Promise<Outcome> {
		try {
			const { stdout, stderr } = await run(binary, [...argv, '--config', config], {
				cwd: root,
				env: { ...process.env, BASTION_CONFIG: config },
				maxBuffer: 16 * 1024 * 1024
			});
			return { code: 0, stdout, stderr };
		} catch (error) {
			const failure = error as { code?: number; stdout?: string; stderr?: string };
			return {
				code: failure.code ?? 1,
				stdout: failure.stdout ?? '',
				stderr: failure.stderr ?? ''
			};
		}
	}

	beforeAll(() => {
		mkdirSync(state, { recursive: true });
		// stage the pinned runtime where `resolveBinary` looks, which is what an install does
		mkdirSync(join(state, 'runtime'), { recursive: true });
		const staged = join(state, 'runtime', `workerd-${PINNED}`);
		copyFileSync(workerd, staged);
		chmodSync(staged, 0o755);
	});

	describe('a first install', () => {
		it('reports its version without a configuration', async () => {
			const answer = await bastion('--version');
			expect(answer.code).toBe(0);
			expect(answer.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
		});

		// a read against a configuration that is not there answers from the defaults rather than
		// refusing, which is what makes `doctor` and `capacity` usable before anything is set up
		it('reads an empty box before init rather than refusing', async () => {
			const answer = await bastion('tenant', 'list');
			expect(answer.code).toBe(0);
			expect(answer.stdout).toMatch(/no tenants/i);
		});

		it('writes a configuration at the path --config names', async () => {
			const answer = await bastion('init');
			expect(answer.code).toBe(0);
			expect(existsSync(config)).toBe(true);
		});

		it('refuses to overwrite one that exists without --force', async () => {
			const answer = await bastion('init');
			expect(answer.code).toBe(2);
			expect(`${answer.stdout}${answer.stderr}`).toMatch(/exists|refus|--force/i);
		});

		it('overwrites when told to', async () => {
			expect((await bastion('init', '--force')).code).toBe(0);
		});

		it('points the state directory at somewhere writable', async () => {
			const answer = await bastion('config', 'set', 'state', state);
			expect(answer.code).toBe(0);
		});

		it('validates what it just wrote', async () => {
			expect((await bastion('config', 'validate')).code).toBe(0);
		});

		it('answers doctor with a limits table', async () => {
			const answer = await bastion('doctor', '--json');
			// exit 3 is a finding rather than a failure, and a bare container has several
			expect([0, 3]).toContain(answer.code);
			const report = JSON.parse(answer.stdout) as { limits?: unknown[] };
			expect(Array.isArray(report.limits)).toBe(true);
		});

		it('reports which optional binding software this host has', async () => {
			const answer = await bastion('capability', 'list', '--json');
			expect([0, 3]).toContain(answer.code);
			const report = JSON.parse(answer.stdout) as { capabilities: { slot: string }[] };
			expect(report.capabilities.map((c) => c.slot)).toContain('images');
		});
	});

	describe('standing up a tenant and a site', () => {
		it('adds a tenant with its limits', async () => {
			const answer = await bastion(
				'tenant',
				'add',
				'acme',
				'--cpu',
				'2',
				'--memory',
				'1Gi',
				'--max-sites',
				'5'
			);
			expect(answer.code).toBe(0);
		});

		it('refuses the same tenant twice', async () => {
			expect((await bastion('tenant', 'add', 'acme')).code).toBe(2);
		});

		it('lists it back', async () => {
			const answer = await bastion('tenant', 'list', '--json');
			expect(answer.code).toBe(0);
			const body = JSON.parse(answer.stdout) as { tenants: { name: string }[] };
			expect(body.tenants.map((t) => t.name)).toContain('acme');
		});

		it('adds a site pointing at a bundle', async () => {
			const bundle = join(root, 'bundle');
			mkdirSync(bundle, { recursive: true });
			writeFileSync(
				join(bundle, 'index.js'),
				"export default { async fetch() { return new Response('served'); } };"
			);
			const answer = await bastion(
				'site',
				'add',
				'www.example.edu',
				'--tenant',
				'acme',
				'--bundle',
				bundle
			);
			expect(answer.code).toBe(0);
		});

		it('refuses a hostname that is already configured', async () => {
			const answer = await bastion('site', 'add', 'www.example.edu', '--tenant', 'acme');
			expect(answer.code).toBe(2);
		});

		it('refuses a tenant that does not exist, and names the command that lists them', async () => {
			const answer = await bastion('site', 'add', 'x.example.edu', '--tenant', 'ghost');
			expect(answer.code).toBe(2);
			expect(`${answer.stdout}${answer.stderr}`).toMatch(/tenant/i);
		});

		it('still validates after every write', async () => {
			expect((await bastion('config', 'validate')).code).toBe(0);
		});
	});

	describe('reading the box', () => {
		it('prints status', async () => {
			expect((await bastion('status', '--json')).code).toBe(0);
		});

		it('prints where each setting came from', async () => {
			const answer = await bastion('config', 'where', '--json');
			expect(answer.code).toBe(0);
			expect(answer.stdout).toContain('state');
		});

		it('prints the capacity answer with its provenance', async () => {
			const answer = await bastion('capacity', '--json');
			expect([0, 3]).toContain(answer.code);
			const body = JSON.parse(answer.stdout) as { provenance?: string };
			expect(body.provenance).toBeTruthy();
		});

		it('renders a manual topic out of the binary, with no network', async () => {
			const answer = await bastion('manual', 'tls');
			expect(answer.code).toBe(0);
			expect(answer.stdout.length).toBeGreaterThan(200);
		});

		it('lists every command it can run', async () => {
			const answer = await bastion('--help');
			expect(answer.code).toBe(0);
			for (const group of ['tenant', 'site', 'backup', 'cluster']) {
				expect(answer.stdout).toContain(group);
			}
		});
	});

	describe('refusals an operator will actually hit', () => {
		it('refuses a command that does not exist', async () => {
			expect((await bastion('nonsense')).code).toBe(2);
		});

		it('refuses a flag that does not exist', async () => {
			expect((await bastion('status', '--made-up')).code).toBe(2);
		});

		it('refuses a tripwire code nothing defines', async () => {
			const answer = await bastion('diagnose', 'not.a.code');
			expect(`${answer.stdout}${answer.stderr}`).toMatch(/not a tripwire|diagnose/i);
		});

		it('refuses a manual topic nothing defines', async () => {
			const answer = await bastion('manual', 'nonsense');
			expect(`${answer.stdout}${answer.stderr}`).toMatch(/topic|list/i);
		});

		it('refuses to install a capability that is not one', async () => {
			expect((await bastion('capability', 'install', 'nonsense')).code).toBe(2);
		});

		it('prints json on the failure path too, so a script can parse either outcome', async () => {
			const answer = await bastion('site', 'show', 'absent.example.edu', '--json');
			expect(answer.code).toBe(2);
			expect(() => JSON.parse(answer.stdout || answer.stderr)).not.toThrow();
		});
	});
});
