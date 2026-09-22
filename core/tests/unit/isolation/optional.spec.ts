import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { scriptedRunner } from '../../../src/host/exec';
import { memoryFiles } from '../../../src/host/files';
import {
	installTool,
	OPTIONAL_TOOLS,
	packageFamily,
	probeOptional
} from '../../../src/isolation/optional';

/**
 * The tools an optional binding needs, none of which a server image ships.
 *
 * The probe answering `absent` is what makes the refusal honest rather than a guess, and the
 * install command is per host: an operator on Alpine handed an `apt-get` line has been given
 * something that cannot work, which is worse than being told nothing.
 */
/**
 * The scripted runner answers an unmatched call `{code: 0}`, which would read as "installed".
 *
 * A real host makes `execFile` reject with ENOENT for a binary that is not there, so absence is
 * scripted explicitly here rather than left to the default; a spec that relied on the default
 * would pass while asserting the opposite of what happens on a box.
 */
const MISSING = { code: 127, stdout: '', stderr: 'command not found' };

function harness(
	seed: Record<string, string> = {},
	handlers: Record<string, { code: number; stdout: string; stderr: string }> = {}
) {
	const files = memoryFiles(seed);
	const runner = scriptedRunner(handlers);
	return { files, runner, ctx: { ...defaultContext(), files, runner } };
}

const absent = { 'magick -version': MISSING, 'chromium --version': MISSING };

describe('packageFamily', () => {
	it('reads apt from the binary rather than from os-release', () => {
		expect(packageFamily(harness({ '/usr/bin/apt-get': '' }).ctx, 'linux')).toBe('debian');
	});

	it('finds dnf', () => {
		expect(packageFamily(harness({ '/usr/bin/dnf': '' }).ctx, 'linux')).toBe('rhel');
	});

	it('finds apk', () => {
		expect(packageFamily(harness({ '/sbin/apk': '' }).ctx, 'linux')).toBe('alpine');
	});

	it('answers darwin from the platform, where there is no package manager to probe', () => {
		expect(packageFamily(harness().ctx, 'darwin')).toBe('darwin');
	});

	it('falls back to debian rather than refusing on a host it does not recognise', () => {
		expect(packageFamily(harness().ctx, 'linux')).toBe('debian');
	});
});

describe('probeOptional', () => {
	it('reports a tool the host does not have as absent', async () => {
		const h = harness({ '/usr/bin/apt-get': '' }, absent);
		const report = await probeOptional(h.ctx, 'linux');
		expect(report.every((entry) => entry.state === 'absent')).toBe(true);
	});

	it('hands back the install command for THIS host', async () => {
		const h = harness({ '/sbin/apk': '' }, absent);
		const images = (await probeOptional(h.ctx, 'linux')).find((e) => e.slot === 'images');
		expect(images?.install).toBe('apk add imagemagick');
	});

	it('reports a tool that answers its probe as present, with the version it printed', async () => {
		const h = harness(
			{ '/usr/bin/apt-get': '' },
			{
				...absent,
				'magick -version': {
					code: 0,
					stdout: 'Version: ImageMagick 7.1.1-47\n',
					stderr: ''
				}
			}
		);
		const images = (await probeOptional(h.ctx, 'linux')).find((e) => e.slot === 'images');
		expect(images?.state).toBe('present');
		expect(images?.version).toBe('Version: ImageMagick 7.1.1-47');
	});

	it('names what each tool is for, so a report is readable without the docs', async () => {
		for (const entry of await probeOptional(harness({}, absent).ctx, 'linux')) {
			expect(entry.why).not.toBe('');
			expect(entry.approxMb).toBeGreaterThan(0);
		}
	});

	it('covers every slot the table declares', async () => {
		const report = await probeOptional(harness({}, absent).ctx, 'linux');
		expect(report.map((e) => e.slot).sort()).toEqual(OPTIONAL_TOOLS.map((t) => t.slot).sort());
	});
});

describe('installTool', () => {
	it('runs the command for the host family', async () => {
		const h = harness(
			{ '/usr/bin/apt-get': '' },
			{ 'apt-get install -y imagemagick': { code: 0, stdout: 'done', stderr: '' } }
		);
		const answer = await installTool(h.ctx, 'images', 'linux');
		expect(answer.ok).toBe(true);
		expect(answer.command).toBe('apt-get install -y imagemagick');
	});

	it('reports the failure rather than throwing, so a button can show it', async () => {
		const h = harness(
			{ '/usr/bin/apt-get': '' },
			{
				'apt-get install -y chromium': {
					code: 100,
					stdout: '',
					stderr: 'E: Unable to locate package'
				}
			}
		);
		const answer = await installTool(h.ctx, 'browser', 'linux');
		expect(answer.ok).toBe(false);
		expect(answer.output).toContain('Unable to locate package');
	});

	it('refuses a slot that is not an optional tool', async () => {
		const answer = await installTool(harness().ctx, 'nonsense', 'linux');
		expect(answer.ok).toBe(false);
		expect(answer.output).toContain('no optional tool');
	});

	it('never builds a shell string; the runner is given argv', async () => {
		const h = harness({ '/usr/bin/apt-get': '' });
		await installTool(h.ctx, 'images', 'linux');
		const call = h.runner.calls.find((c) => c.command === 'apt-get');
		expect(call?.args).toEqual(['install', '-y', 'imagemagick']);
	});
});
