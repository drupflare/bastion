import type { Mode } from '../config/types';
import type { Context } from '../context';
import { MODE_TABLE } from './modes';

export interface MechanismCheck {
	id: string;
	label: string;
	present: boolean;
	/** how it was determined, so a report never presents an inference as a reading */
	source: 'probed' | 'assumed';
	detail: string;
}

export interface Preflight {
	platform: string;
	mechanisms: MechanismCheck[];
	/** modes this host can actually run */
	available: Mode[];
	/** why each unavailable mode is unavailable, by the mechanism that is missing */
	refusals: Record<string, string[]>;
}

const CGROUP_ROOT = '/sys/fs/cgroup/cgroup.controllers';
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const KVM = '/dev/kvm';
const APPARMOR = '/sys/module/apparmor/parameters/enabled';
const SECCOMP_STATUS = '/proc/self/status';

/** whether an executable bastion actually invokes is on this host's PATH */
export function binaryOnPath(ctx: Context, name: string): string | null {
	const search = (ctx.env.PATH ?? DEFAULT_PATH).split(':').filter((d) => d !== '');
	for (const dir of search) {
		const candidate = `${dir}/${name}`;
		if (ctx.files.exists(candidate)) return candidate;
	}
	return null;
}

/**
 * What this host can do, read from the host rather than assumed from the platform name.
 *
 * Every mechanism reports how it was determined. A check that could not run is `assumed` absent,
 * never `probed` present: the cost of the two mistakes is not symmetric, because a mode believed
 * available and silently weaker is the failure this project exists to prevent.
 */
export function preflight(ctx: Context, platform: string = ctx.platform): Preflight {
	const linux = platform === 'linux';
	const mechanisms: MechanismCheck[] = [];

	const probeFile = (id: string, label: string, path: string, detail: string): void => {
		if (!linux) {
			mechanisms.push({ id, label, present: false, source: 'assumed', detail: 'not linux' });
			return;
		}
		const present = ctx.files.exists(path);
		mechanisms.push({
			id,
			label,
			present,
			source: 'probed',
			detail: present ? detail : `${path} is absent`
		});
	};

	probeFile('cgroups-v2', 'cgroups v2', CGROUP_ROOT, CGROUP_ROOT);
	probeFile('kvm', 'KVM', KVM, KVM);

	// each of the three below needs the KERNEL feature and the TOOL bastion drives it with. A host
	// with the feature and no tool cannot actually be hardened, and reporting it as present is the
	// silent downgrade the mode table exists to prevent
	const both = (
		id: string,
		label: string,
		kernel: { ok: boolean; detail: string },
		tool: string
	): void => {
		if (!linux) {
			mechanisms.push({ id, label, present: false, source: 'assumed', detail: 'not linux' });
			return;
		}
		const found = binaryOnPath(ctx, tool);
		mechanisms.push({
			id,
			label,
			present: kernel.ok && found !== null,
			source: 'probed',
			detail: !kernel.ok ? kernel.detail : found === null ? `${tool} is not on PATH` : found
		});
	};

	const nsPath = '/proc/self/ns/net';
	both(
		'netns',
		'network namespaces',
		{ ok: linux && ctx.files.exists(nsPath), detail: `${nsPath} is absent` },
		'ip'
	);
	both(
		'apparmor',
		'AppArmor',
		{ ok: linux && ctx.files.exists(APPARMOR), detail: `${APPARMOR} is absent` },
		'aa-exec'
	);
	both(
		'seccomp',
		'seccomp',
		{
			ok:
				linux &&
				ctx.files.exists(SECCOMP_STATUS) &&
				ctx.files.readText(SECCOMP_STATUS).includes('Seccomp'),
			detail: 'no Seccomp line in /proc/self/status'
		},
		'systemd-run'
	);

	const have = new Set(mechanisms.filter((m) => m.present).map((m) => m.id));
	const available: Mode[] = [];
	const refusals: Record<string, string[]> = {};
	for (const description of Object.values(MODE_TABLE)) {
		const missing = description.requires.filter((r) => !have.has(r));
		if (missing.length === 0) available.push(description.mode);
		else refusals[description.mode] = missing;
	}

	return { platform, mechanisms, available, refusals };
}

/**
 * Whether a mode may run here, and what is missing when it may not.
 *
 * **A preflight that used to pass and now fails never downgrades the mode.** It refuses and names
 * the mechanism that disappeared; silently serving `hardened` where the operator configured
 * `isolated` is exactly the failure the mode table exists to prevent.
 */
export function modeAvailable(
	report: Preflight,
	mode: Mode
): { ok: boolean; missing: string[]; message: string } {
	const missing = report.refusals[mode] ?? [];
	if (missing.length === 0) return { ok: true, missing: [], message: '' };
	return {
		ok: false,
		missing,
		message:
			`\`${mode}\` needs ${missing.join(', ')} and this host does not provide ` +
			`${missing.length === 1 ? 'it' : 'them'}. bastion will not run a weaker mode in its place.`
	};
}
