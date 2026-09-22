import { EXIT, memoryFiles, memoryIo, scriptedRunner, type Context } from '@drupflare/bastion';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run';

const GOOD = `
version: 1
mode: solo
tenants:
  - name: acme
    sites:
      - host: www.example.edu
        bundle: ./payload.tar.gz
`;

function harness(files: Record<string, string> = {}): {
	ctx: Context;
	io: ReturnType<typeof memoryIo>;
} {
	const io = memoryIo();
	return {
		io,
		ctx: {
			io,
			files: memoryFiles(files),
			runner: scriptedRunner(),
			fetch: () => Promise.reject(new Error('no network in the gate lane')),
			env: {},
			cwd: '/srv',
			platform: 'linux',
			now: () => 0
		}
	};
}

describe('exit codes are a closed set', () => {
	it('exits 0 on success', async () => {
		const { ctx } = harness({ '/srv/bastion.yml': 'version: 1\nmode: solo\n' });
		expect(await run(ctx, ['config', 'show'])).toBe(EXIT.OK);
	});

	it('exits 3 when doctor ran and found this host cannot run the configured mode', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['doctor'])).toBe(EXIT.FINDING);
	});

	it('exits 2 for a command that does not exist, rather than 1', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['nonsense'])).toBe(EXIT.USAGE);
	});

	it('exits 2 for an unknown flag', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['doctor', '--made-up'])).toBe(EXIT.USAGE);
	});

	it('exits 2 on bad input', async () => {
		const { ctx } = harness();
		expect(await run(ctx, ['config', 'validate'])).toBe(EXIT.USAGE);
	});

	it('exits 2 when the config is invalid, and names the path of each problem', async () => {
		const { ctx, io } = harness({ '/srv/bastion.yml': 'version: 1\nmode: yolo\n' });
		expect(await run(ctx, ['config', 'validate'])).toBe(EXIT.USAGE);
		expect(io.errText()).toContain('mode: must be one of');
	});

	it('exits 0 when the config is valid', async () => {
		const { ctx, io } = harness({ '/srv/bastion.yml': GOOD });
		expect(await run(ctx, ['config', 'validate'])).toBe(EXIT.OK);
		expect(io.outText()).toContain('is valid');
	});
});

describe('global flags parse in either position', () => {
	// `bastion doctor --json` is the order everyone types, and it used to fail: the flag was
	// declared only on the program, so commander refused it after the subcommand name. The
	// original spec only ever passed it BEFORE, so the suite was green while the binary was not.
	for (const argv of [
		['--json', 'doctor'],
		['doctor', '--json']
	]) {
		it(`accepts ${argv.join(' ')}`, async () => {
			const { ctx, io } = harness();
			// a finding rather than 0, because this host cannot run the configured mode. What the
			// test is about is that the flag PARSED in either position
			expect(await run(ctx, argv)).toBe(EXIT.FINDING);
			expect(io.stdout).toHaveLength(1);
			expect(() => JSON.parse(io.outText())).not.toThrow();
		});
	}

	for (const argv of [
		['--config', '/srv/bastion.yml', 'config', 'validate'],
		['config', 'validate', '--config', '/srv/bastion.yml']
	]) {
		it(`accepts --config as ${argv.join(' ')}`, async () => {
			const { ctx, io } = harness({ '/srv/bastion.yml': GOOD });
			expect(await run(ctx, argv)).toBe(EXIT.OK);
			expect(io.outText()).toContain('is valid');
		});
	}
});

describe('--json', () => {
	// stdout carries the report object and nothing else, so a caller can parse without branching
	it('prints one parseable object on the success path', async () => {
		const { ctx, io } = harness({ '/srv/bastion.yml': GOOD });
		await run(ctx, ['--json', 'doctor']);
		expect(io.stdout).toHaveLength(1);
		const report = JSON.parse(io.outText()) as { platform: string; limits: unknown[] };
		// the platform the CONTEXT names, not the runner's own: the seam is what lets this suite
		// reach the linux paths from a mac, and asserting the global would pin it back
		expect(report.platform).toBe(ctx.platform);
		expect(report.limits.length).toBeGreaterThan(0);
	});

	it('parses on the FAILURE path too', async () => {
		const { ctx, io } = harness({ '/srv/bastion.yml': 'version: 1\nmode: yolo\n' });
		const code = await run(ctx, ['--json', 'config', 'validate']);
		expect(code).toBe(EXIT.USAGE);
		const all = io.stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
		// both the report and the error object are objects, and neither is prose
		expect(all.every((o) => typeof o === 'object')).toBe(true);
		expect(all.some((o) => o.ok === false)).toBe(true);
	});

	it('never puts prose on stdout when it fails', async () => {
		const { ctx, io } = harness();
		await run(ctx, ['--json', 'config', 'validate']);
		for (const line of io.stdout) expect(() => JSON.parse(line)).not.toThrow();
	});
});

describe('errors carry a code and a next command', () => {
	it('reports the code in the json error object', async () => {
		const { ctx, io } = harness();
		await run(ctx, ['--json', 'config', 'validate']);
		const error = JSON.parse(io.outText()) as { error: { code: string; retryable: boolean } };
		expect(error.error.code).toBe('usage');
		expect(error.error.retryable).toBe(false);
	});
});

describe('doctor', () => {
	it('reports the enforced/declared split for every limit', async () => {
		const { ctx, io } = harness();
		await run(ctx, ['--json', 'doctor']);
		const report = JSON.parse(io.outText()) as {
			limits: { limit: string; workerd: string; bastion: string }[];
		};
		// standalone workerd enforces none of them; that is the whole reason for the column
		for (const row of report.limits) {
			if (row.limit === 'alarm') continue;
			expect(row.workerd).toBe('none');
		}
		const subrequests = report.limits.find((l) => l.limit === 'subrequests');
		expect(subrequests?.bastion).toContain('declared, not enforced');
	});

	it('never claims a mechanism is present that it could not probe', async () => {
		const { ctx, io } = harness();
		await run(ctx, ['--json', 'doctor']);
		const report = JSON.parse(io.outText()) as {
			mechanisms: { present: boolean; source: string }[];
		};
		for (const m of report.mechanisms) {
			if (m.source === 'assumed') expect(m.present).toBe(false);
		}
	});
});

describe('config where', () => {
	it('attributes each value the file set', async () => {
		const { ctx, io } = harness({ '/srv/bastion.yml': GOOD });
		await run(ctx, ['--json', 'config', 'where']);
		const report = JSON.parse(io.outText()) as {
			settings: { key: string; origin: string; from: string }[];
		};
		const mode = report.settings.find((s) => s.key === 'mode');
		expect(mode?.origin).toBe('file');
		expect(mode?.from).toBe('/srv/bastion.yml');
		// a key the file never set is absent, which reads as a default
		expect(report.settings.some((s) => s.key === 'front.http3')).toBe(false);
	});
});
