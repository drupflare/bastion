import { describe, expect, it } from 'vitest';
import { defaultContext } from '../../../src/context';
import { scriptedRunner } from '../../../src/host/exec';
import { memoryFiles } from '../../../src/host/files';
import { memoryIo } from '../../../src/io';
import {
	buildSecrets,
	envSecrets,
	fileSecrets,
	keyringSecrets,
	kmsSecrets,
	redact,
	type KmsClient
} from '../../../src/secrets/store';

function ctx(over: Record<string, unknown> = {}) {
	return {
		...defaultContext(),
		files: memoryFiles(),
		runner: scriptedRunner(),
		io: memoryIo(),
		env: {},
		now: () => 100,
		...over
	};
}

describe('envSecrets', () => {
	it('reads a variable and normalises the name', async () => {
		const store = envSecrets(ctx({ env: { BASTION_SECRET_SMTP_PASS: 'hunter2' } }));
		expect(await store.get('smtp-pass')).toBe('hunter2');
	});

	it('answers null for one that is not set', async () => {
		expect(await envSecrets(ctx()).get('nope')).toBe(null);
	});

	it('refuses a write rather than pretending to persist one', async () => {
		await expect(envSecrets(ctx()).set('a', 'b')).rejects.toThrow(/read-only/);
		await expect(envSecrets(ctx()).remove('a')).rejects.toThrow(/read-only/);
	});

	it('lists names and never values', async () => {
		const store = envSecrets(ctx({ env: { BASTION_SECRET_A: 'x', PATH: '/bin' } }));
		const listed = await store.list();
		expect(listed).toEqual([{ name: 'a', driver: 'env', updatedAt: 0 }]);
		expect(JSON.stringify(listed)).not.toContain('x');
	});
});

describe('fileSecrets', () => {
	it('round trips through the encrypted file', async () => {
		const context = ctx();
		const store = fileSecrets(context, '/secrets.age', 'passphrase');
		await store.set('smtp', 'hunter2');
		expect(await store.get('smtp')).toBe('hunter2');
	});

	it('writes ciphertext, so the value is not on disk in the clear', async () => {
		const context = ctx();
		await fileSecrets(context, '/secrets.age', 'passphrase').set('smtp', 'hunter2');
		const raw = Buffer.from(context.files.readBytes('/secrets.age')).toString('latin1');
		expect(raw).not.toContain('hunter2');
	});

	it('writes the file readable by nobody else', async () => {
		const context = ctx();
		await fileSecrets(context, '/secrets.age', 'passphrase').set('a', 'b');
		expect(context.files.mode('/secrets.age')).toBe(0o600);
	});

	it('refuses the wrong passphrase rather than answering null', async () => {
		const context = ctx();
		await fileSecrets(context, '/secrets.age', 'right').set('a', 'b');
		await expect(fileSecrets(context, '/secrets.age', 'wrong').get('a')).rejects.toThrow(
			/did not decrypt/
		);
	});

	it('is sealed with no passphrase, and says so rather than failing obscurely', async () => {
		const store = fileSecrets(ctx(), '/secrets.age', null);
		expect(store.sealed()).toBe(true);
		await expect(store.get('a')).rejects.toThrow(/sealed/);
	});

	it('removes a secret', async () => {
		const context = ctx();
		const store = fileSecrets(context, '/secrets.age', 'p');
		await store.set('a', 'b');
		await store.remove('a');
		expect(await store.get('a')).toBe(null);
	});

	it('lists names with their update time and no values', async () => {
		const context = ctx();
		const store = fileSecrets(context, '/secrets.age', 'p');
		await store.set('a', 'secret-value');
		const listed = await store.list();
		expect(listed).toEqual([{ name: 'a', driver: 'file', updatedAt: 100 }]);
		expect(JSON.stringify(listed)).not.toContain('secret-value');
	});

	it('answers nothing for a file that is not there yet', async () => {
		expect(await fileSecrets(ctx(), '/nothing.age', 'p').list()).toEqual([]);
	});
});

/**
 * Both helpers, driven explicitly.
 *
 * The platform is a parameter here rather than whatever the build machine happens to be, because
 * the two branches call different binaries: a suite that scripts only `security` passes on macOS
 * and, on Linux, gets `scriptedRunner`'s unscripted default of exit 0 with empty stdout, which the
 * driver reads as an entry that exists and is empty. That failed only in CI.
 */
describe.each([
	['darwin', 'security'],
	['linux', 'secret-tool']
])('keyringSecrets on %s', (platform, helper) => {
	it('answers null for a missing entry', async () => {
		const missing = keyringSecrets(
			ctx({
				runner: scriptedRunner({
					[helper]: { code: 1, stdout: '', stderr: 'could not be found' }
				})
			}),
			'bastion',
			platform
		);
		expect(await missing.get('a')).toBe(null);
	});

	it('raises rather than answering null for a locked keyring', async () => {
		const locked = keyringSecrets(
			ctx({
				runner: scriptedRunner({
					[helper]: { code: 1, stdout: '', stderr: 'interaction required' }
				})
			}),
			'bastion',
			platform
		);
		await expect(locked.get('a')).rejects.toThrow(/keyring answered/);
	});

	it('strips the trailing newline the helper prints', async () => {
		const store = keyringSecrets(
			ctx({
				runner: scriptedRunner({
					[helper]: { code: 0, stdout: 'hunter2\n', stderr: '' }
				})
			}),
			'bastion',
			platform
		);
		expect(await store.get('a')).toBe('hunter2');
	});

	it(`calls ${helper} and not the other platform's binary`, async () => {
		const runner = scriptedRunner({
			[helper]: { code: 0, stdout: 'v\n', stderr: '' }
		});
		await keyringSecrets(ctx({ runner }), 'bastion', platform).get('a');
		expect(runner.calls.map((call) => call.command)).toEqual([helper]);
	});
});

describe('keyringSecrets', () => {
	it('lists nothing, because a keyring cannot be enumerated safely', async () => {
		expect(await keyringSecrets(ctx()).list()).toEqual([]);
	});
});

describe('kmsSecrets', () => {
	const client: KmsClient = {
		encrypt: async (plain) => new Uint8Array([0xaa, ...plain]),
		decrypt: async (sealed) => sealed.subarray(1)
	};

	it('stores only what the client sealed', async () => {
		const context = ctx();
		const store = kmsSecrets(context, client, '/secrets.kms');
		await store.set('a', 'b');
		expect(context.files.readBytes('/secrets.kms')[0]).toBe(0xaa);
		expect(await store.get('a')).toBe('b');
	});

	it('lists names without values', async () => {
		const store = kmsSecrets(ctx(), client, '/secrets.kms');
		await store.set('a', 'topsecret');
		expect(JSON.stringify(await store.list())).not.toContain('topsecret');
	});
});

describe('buildSecrets', () => {
	it('builds each driver by id', () => {
		expect(buildSecrets(ctx(), { driver: 'env' }).id()).toBe('env');
		expect(buildSecrets(ctx(), { driver: 'keyring' }).id()).toBe('keyring');
		expect(buildSecrets(ctx(), { driver: 'file' }).id()).toBe('file');
	});

	it('refuses kms without a client rather than choosing a vendor', () => {
		expect(() => buildSecrets(ctx(), { driver: 'kms' })).toThrow(/needs a client/);
	});

	it('refuses an unknown driver', () => {
		expect(() => buildSecrets(ctx(), { driver: 'magic' })).toThrow(/unknown secrets driver/);
	});
});

describe('redact', () => {
	it('replaces every string, however deep', () => {
		expect(redact({ a: 'x', b: { c: ['y'] } })).toEqual({
			a: '(redacted)',
			b: { c: ['(redacted)'] }
		});
	});

	it('leaves structure and non-strings, so a shape stays readable', () => {
		expect(redact({ count: 3, on: true, missing: null })).toEqual({
			count: 3,
			on: true,
			missing: null
		});
	});
});
