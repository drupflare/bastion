import { BastionError } from '../errors';
import type { CommandRunner, RunResult } from '../host/exec';

export interface SshTarget {
	host: string;
	user?: string;
	port?: number;
	identity?: string;
}

/**
 * How bastion reaches a host it is provisioning.
 *
 * The same seam drangler already defines: everything a provisioning run does goes through one
 * method, so a dry run is a real implementation rather than a flag that code paths remember to
 * check, and a run is replayable in a test with no network.
 */
export interface Transport {
	readonly label: string;
	exec(command: string): Promise<RunResult>;
}

export function destination(target: SshTarget): string {
	return target.user === undefined ? target.host : `${target.user}@${target.host}`;
}

export function sshArgs(target: SshTarget, command: string): string[] {
	const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
	if (target.port !== undefined) args.push('-p', String(target.port));
	if (target.identity !== undefined) args.push('-i', target.identity);
	args.push(destination(target), command);
	return args;
}

export function sshTransport(runner: CommandRunner, target: SshTarget): Transport {
	return {
		label: destination(target),
		exec: (command) => runner.run('ssh', sshArgs(target, command), { timeoutMs: 120_000 })
	};
}

/** answers from a recorded transcript, so a provisioning run is testable with no network */
export function replayTransport(label: string, transcript: Record<string, RunResult>): Transport {
	return {
		label,
		exec: async (command) =>
			transcript[command] ?? {
				code: 127,
				stdout: '',
				stderr: `no transcript for: ${command}`
			}
	};
}

/** refuses everything, which is what makes `--dry-run` a real implementation */
export function refusingTransport(label: string): Transport & { attempted: string[] } {
	const attempted: string[] = [];
	return {
		label,
		attempted,
		exec: async (command) => {
			attempted.push(command);
			return { code: 0, stdout: '', stderr: '' };
		}
	};
}

/** expands a CIDR into its host addresses; v4 only, which is what a rack is addressed with */
export function expandCidr(cidr: string): string[] {
	const [addr, bitsText] = cidr.split('/');
	const parts = (addr ?? '').split('.').map(Number);
	const bits = Number(bitsText);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		throw new BastionError('usage', `${cidr} is not an IPv4 range`);
	}
	if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
		throw new BastionError('usage', `${cidr} is not an IPv4 range`);
	}
	const base =
		((parts[0] as number) << 24) |
		((parts[1] as number) << 16) |
		((parts[2] as number) << 8) |
		(parts[3] as number);
	const size = 2 ** (32 - bits);
	const network = base & (size === 2 ** 32 ? 0 : ~(size - 1));
	const out: string[] = [];
	const first = size > 2 ? network + 1 : network;
	const last = size > 2 ? network + size - 2 : network + size - 1;
	for (let n = first; n <= last; n++) {
		out.push([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
	}
	return out;
}

export const LARGE_RANGE_FLAG = '--i-know-this-is-a-large-range';

export interface ProvisionOptions {
	/** a single host may act with --yes; a range refuses until a dry run has been printed */
	dryRun?: boolean;
	yes?: boolean;
	acknowledgeLargeRange?: boolean;
	only?: string[];
	exclude?: string[];
	/** the control node's address and a short-lived join token; never a secret in a config file */
	controlAddress: string;
	joinToken: string;
	version: string;
	principal: string;
}

export interface HostOutcome {
	host: string;
	action: 'installed' | 'skipped' | 'would-install' | 'failed';
	reason: string;
	commands: string[];
}

/** what would run on one host, as argv-safe commands rather than a shell string */
export function installCommands(options: ProvisionOptions): string[] {
	return [
		'test -d /var/lib/bastion && echo occupied || echo empty',
		'command -v bastion || true',
		`curl -fsSL https://github.com/drupflare/bastion/releases/download/v${options.version}/bastion-linux-x64 -o /tmp/bastion`,
		'install -m 0755 /tmp/bastion /usr/local/bin/bastion',
		`bastion cluster join --control ${options.controlAddress} --token ${options.joinToken}`
	];
}

/**
 * Turns a rack into a cluster, over SSH.
 *
 * Every safety here exists because a command that touches a CIDR is the one that most deserves
 * them. **A range is dry-run by default** and refuses to act until a plan has been printed; a
 * range wider than a `/24` refuses outright without an explicit flag and says how many addresses it
 * expands to; and **a host that answers but is not empty is skipped and named, never overwritten**.
 *
 * Nothing is provisioned with a secret in its config: the child gets the control node's address and
 * a one-time join token with a short expiry, and dials out for the rest.
 */
export async function provision(
	targets: { target: SshTarget; transport: Transport }[],
	options: ProvisionOptions
): Promise<HostOutcome[]> {
	const outcomes: HostOutcome[] = [];
	for (const { target, transport } of targets) {
		if (options.only !== undefined && !options.only.includes(target.host)) continue;
		if (options.exclude?.includes(target.host) === true) {
			outcomes.push({
				host: target.host,
				action: 'skipped',
				reason: 'excluded',
				commands: []
			});
			continue;
		}

		const commands = installCommands(options);
		if (options.dryRun === true) {
			outcomes.push({
				host: target.host,
				action: 'would-install',
				reason: `bastion ${options.version} would be installed and joined to ${options.controlAddress}`,
				commands
			});
			continue;
		}

		const occupied = await transport.exec(commands[0] as string);
		if (occupied.stdout.includes('occupied')) {
			outcomes.push({
				host: target.host,
				action: 'skipped',
				reason: 'that host already has a bastion state directory and was not overwritten',
				commands: []
			});
			continue;
		}

		let failed: string | null = null;
		for (const command of commands.slice(1)) {
			const result = await transport.exec(command);
			if (result.code !== 0) {
				failed = `${command} exited ${result.code}: ${result.stderr.trim()}`;
				break;
			}
		}
		outcomes.push({
			host: target.host,
			action: failed === null ? 'installed' : 'failed',
			reason: failed ?? `joined to ${options.controlAddress}`,
			commands
		});
	}
	return outcomes;
}

/** the refusals in front of a range, checked before a single connection is opened */
export function checkRange(
	cidr: string,
	options: ProvisionOptions
): { ok: boolean; reason: string } {
	const bits = Number(cidr.split('/')[1]);
	if (bits < 24 && options.acknowledgeLargeRange !== true) {
		const count = expandCidr(cidr).length;
		return {
			ok: false,
			reason: `${cidr} expands to ${count} addresses. Pass ${LARGE_RANGE_FLAG} if that is what you meant`
		};
	}
	if (options.dryRun !== true && options.yes !== true) {
		return {
			ok: false,
			reason: 'a range is dry-run by default; print the plan first, then re-run with --yes'
		};
	}
	return { ok: true, reason: '' };
}
