import { describe, expect, it } from 'vitest';
import type { Context } from '../../../src/context';
import { scriptedRunner } from '../../../src/host/exec';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import {
	assertArgvSafe,
	binaryPath,
	FORBIDDEN_FLAGS,
	resolveBinary,
	serveArgv,
	sha256
} from '../../../src/workerd/binary';

const BYTES = new TextEncoder().encode('not really workerd');
const DIGEST = sha256(BYTES);
const STATE = '/var/lib/bastion';
const PATH = binaryPath(STATE, '1.20260828.1');

function harness(files = memoryFiles({ [PATH]: BYTES })): {
	ctx: Context;
	io: ReturnType<typeof memoryIo>;
} {
	const io = memoryIo();
	const ctx: Context = {
		io,
		files,
		runner: scriptedRunner(),
		fetch: () => Promise.reject(new Error('no network in the gate lane')),
		env: {},
		cwd: '/',
		now: () => 0
	};
	return { ctx, io };
}

const ctx = (files = memoryFiles({ [PATH]: BYTES })): Context => harness(files).ctx;

describe('forbidden flags', () => {
	// a privileged interface over every service in the process, and NOT experimental-gated
	for (const flag of FORBIDDEN_FLAGS) {
		it(`refuses ${flag}`, () => {
			expect(() => assertArgvSafe(['serve', 'x.capnp', flag])).toThrow(/every service/);
		});

		it(`refuses ${flag} in its = form too`, () => {
			expect(() => assertArgvSafe(['serve', 'x.capnp', `${flag}=1.2.3.4:9229`])).toThrow();
		});
	}

	it('allows an ordinary serve argv', () => {
		expect(() => assertArgvSafe(['serve', '/etc/bastion/t/a.capnp'])).not.toThrow();
	});

	it('builds a serve argv that passed the check', () => {
		expect(serveArgv('/etc/x.capnp')).toEqual(['serve', '/etc/x.capnp']);
		expect(() => serveArgv('/etc/x.capnp', ['--debug-port=9229'])).toThrow();
	});
});

describe('resolveBinary', () => {
	const pin = { version: '1.20260828.1', digest: DIGEST };
	const floor = 'v1.20231121.0';

	it('resolves a pinned binary whose digest matches', () => {
		const resolved = resolveBinary(ctx(), { state: STATE, pin, floor, verify: 'sha256' });
		expect(resolved.path).toBe(PATH);
		expect(resolved.digest).toBe(DIGEST);
	});

	// the digest is the pin; a tag can be rebuilt, so checking it verifies nothing about the bytes
	it('refuses a binary whose digest does not match the pin', () => {
		expect(() =>
			resolveBinary(ctx(), {
				state: STATE,
				pin: { ...pin, digest: 'f'.repeat(64) },
				floor,
				verify: 'sha256'
			})
		).toThrow(/hashes/);
	});

	it('skips the digest check when verification is off', () => {
		expect(
			resolveBinary(ctx(), {
				state: STATE,
				pin: { ...pin, digest: 'f'.repeat(64) },
				floor,
				verify: 'none'
			}).digest
		).toBe(DIGEST);
	});

	it('raises when the binary is absent', () => {
		expect(() =>
			resolveBinary(ctx(memoryFiles()), { state: STATE, pin, floor, verify: 'sha256' })
		).toThrow(/no workerd/);
	});

	it('refuses a pin below the floor before it looks at the disk', () => {
		expect(() =>
			resolveBinary(ctx(memoryFiles()), {
				state: STATE,
				pin: { version: '1.20230419.0' },
				floor,
				verify: 'none'
			})
		).toThrow(/CVE-2023-48230/);
	});

	it('accepts a forced pin below the floor and warns on stderr', () => {
		const files = memoryFiles({ [binaryPath(STATE, '1.20230419.0')]: BYTES });
		const { ctx: c, io } = harness(files);
		const resolved = resolveBinary(c, {
			state: STATE,
			pin: { version: '1.20230419.0' },
			floor,
			verify: 'none',
			forceBelowFloor: true
		});
		expect(resolved.version).toBe('1.20230419.0');
		// accepted, never silent
		expect(io.errText()).toContain('CVE-2023-48230');
	});
});
