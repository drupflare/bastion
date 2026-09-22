/**
 * The host tools an optional binding needs, and how to get them.
 *
 * Every entry here is something a server image does not ship. ImageMagick is absent from Debian,
 * Ubuntu, RHEL and Alpine until somebody installs it; no image carries a headless browser. bastion
 * reports what is present and hands back the exact command for what is not, and installing is the
 * operator's act rather than something that happens because a site asked for it.
 */

import type { Context } from '../context';

export interface OptionalTool {
	/** the `drivers` key it backs */
	slot: string;
	/** what bastion runs to find out whether it is there */
	probe: { command: string; args: string[] };
	/** the package manager command per family, so the answer is copy-pasteable */
	install: Record<string, string>;
	/** roughly what it costs on disk, so an operator sizing a box is not surprised */
	approxMb: number;
	why: string;
}

export const OPTIONAL_TOOLS: OptionalTool[] = [
	{
		slot: 'images',
		probe: { command: 'magick', args: ['-version'] },
		install: {
			debian: 'apt-get install -y imagemagick',
			rhel: 'dnf install -y ImageMagick',
			alpine: 'apk add imagemagick',
			darwin: 'brew install imagemagick'
		},
		approxMb: 120,
		why: 'decodes, resizes and re-encodes for the Images binding'
	},
	{
		slot: 'browser',
		probe: { command: 'chromium', args: ['--version'] },
		install: {
			debian: 'apt-get install -y chromium',
			rhel: 'dnf install -y chromium',
			alpine: 'apk add chromium',
			darwin: 'brew install --cask chromium'
		},
		approxMb: 450,
		why: 'renders pages for the Browser binding: screenshots, pdfs and dom captures'
	}
];

export type ToolState = 'present' | 'absent';

export interface ToolReport {
	slot: string;
	command: string;
	state: ToolState;
	/** the version string the probe printed, which is what makes `present` checkable */
	version: string | null;
	approxMb: number;
	why: string;
	/** the command for THIS host, chosen from the family the probe found */
	install: string;
}

/**
 * Picks the package manager by what is on the box rather than by parsing a release file.
 *
 * `/etc/os-release` names a distribution and not its package manager, and derivatives disagree
 * with their parents often enough that the file is the wrong thing to branch on. The manager's own
 * binary is the fact that matters.
 */
export function packageFamily(ctx: Context, platform: string = process.platform): string {
	if (platform === 'darwin') return 'darwin';
	if (ctx.files.exists('/usr/bin/apt-get') || ctx.files.exists('/bin/apt-get')) return 'debian';
	if (ctx.files.exists('/usr/bin/dnf') || ctx.files.exists('/usr/bin/yum')) return 'rhel';
	if (ctx.files.exists('/sbin/apk') || ctx.files.exists('/usr/bin/apk')) return 'alpine';
	return 'debian';
}

/** probes one tool, answering absent rather than throwing when the binary is not there at all */
export async function probeTool(
	ctx: Context,
	tool: OptionalTool,
	family: string
): Promise<ToolReport> {
	let version: string | null = null;
	try {
		const result = await ctx.runner.run(tool.probe.command, tool.probe.args);
		if (result.code === 0) version = result.stdout.split('\n')[0]?.trim() ?? '';
	} catch {
		version = null;
	}
	return {
		slot: tool.slot,
		command: tool.probe.command,
		state: version === null ? 'absent' : 'present',
		version,
		approxMb: tool.approxMb,
		why: tool.why,
		install: tool.install[family] ?? tool.install.debian ?? ''
	};
}

export async function probeOptional(
	ctx: Context,
	platform: string = process.platform
): Promise<ToolReport[]> {
	const family = packageFamily(ctx, platform);
	const out: ToolReport[] = [];
	for (const tool of OPTIONAL_TOOLS) out.push(await probeTool(ctx, tool, family));
	return out;
}

/**
 * Runs the install for one tool.
 *
 * Privileged and outward-facing, so it is never implicit: nothing calls this because a site bound
 * a capability. The dashboard button and `bastion doctor --install` both reach it, both record the
 * principal in the audit log, and both report the command they ran so an operator can see exactly
 * what touched their box.
 */
export async function installTool(
	ctx: Context,
	slot: string,
	platform: string = process.platform
): Promise<{ ok: boolean; command: string; output: string }> {
	const tool = OPTIONAL_TOOLS.find((entry) => entry.slot === slot);
	if (tool === undefined)
		return { ok: false, command: '', output: `no optional tool for ${slot}` };

	const family = packageFamily(ctx, platform);
	const command = tool.install[family] ?? '';
	if (command === '') {
		return { ok: false, command: '', output: `no install command for ${family}` };
	}
	// execFile with the parts, never a shell: the strings here are bastion's own, and keeping the
	// shape argv-only means a future entry cannot become an injection by being edited carelessly
	const parts = command.split(' ');
	const head = parts[0] as string;
	const result = await ctx.runner.run(head, parts.slice(1), { timeoutMs: 600_000 });
	return {
		ok: result.code === 0,
		command,
		output: result.code === 0 ? result.stdout : result.stderr
	};
}
