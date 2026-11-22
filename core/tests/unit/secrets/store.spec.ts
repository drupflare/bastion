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
	tenantOfScope,
	tenantScope,
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

/**
 * A tenant's secrets are a different scope from the host's, and a different one from every other
 * tenant's. The file driver keeps each in its own file under its own key, so these read the bytes
 * rather than trusting the API to keep them apart.
 */
describe('secret scopes', () => {
	const PASSPHRASE = 'a passphrase for the specs';

	it('keeps a tenant secret out of the host scope and the host secret out of the tenant', async () => {
		const context = ctx();
		const host = fileSecrets(context, '/s.age', PASSPHRASE);
		await host.set('HOST_ONLY', 'host-value');
		await host.scope(tenantScope('acme')).set('TENANT_ONLY', 'acme-value');
		expect(await host.get('TENANT_ONLY')).toBe(null);
		expect(await host.scope(tenantScope('acme')).get('HOST_ONLY')).toBe(null);
		expect(await host.get('HOST_ONLY')).toBe('host-value');
	});

	it('gives two tenants the same secret name without either seeing the other', async () => {
		const host = fileSecrets(ctx(), '/s.age', PASSPHRASE);
		await host.scope(tenantScope('acme')).set('SMTP', 'acme-pass');
		await host.scope(tenantScope('labs')).set('SMTP', 'labs-pass');
		expect(await host.scope(tenantScope('acme')).get('SMTP')).toBe('acme-pass');
		expect(await host.scope(tenantScope('labs')).get('SMTP')).toBe('labs-pass');
		expect((await host.scope(tenantScope('acme')).list()).map((ref) => ref.name)).toEqual([
			'SMTP'
		]);
	});

	it('does not decrypt one tenant file under another tenant key, even when moved there', async () => {
		const context = ctx();
		const host = fileSecrets(context, '/s.age', PASSPHRASE);
		await host.scope(tenantScope('acme')).set('SMTP', 'acme-pass');
		context.files.writeBytes(
			'/s.age.tenant-labs',
			context.files.readBytes('/s.age.tenant-acme')
		);
		await expect(host.scope(tenantScope('labs')).get('SMTP')).rejects.toThrow(
			/did not decrypt/
		);
	});

	it('does not decrypt a tenant file as the host file either', async () => {
		const context = ctx();
		const host = fileSecrets(context, '/s.age', PASSPHRASE);
		await host.scope(tenantScope('acme')).set('SMTP', 'acme-pass');
		context.files.writeBytes('/s.age', context.files.readBytes('/s.age.tenant-acme'));
		await expect(host.get('SMTP')).rejects.toThrow(/did not decrypt/);
	});

	it('writes a tenant file that is not readable by anyone else', async () => {
		const context = ctx();
		await fileSecrets(context, '/s.age', PASSPHRASE).scope(tenantScope('acme')).set('A', 'b');
		expect(context.files.mode('/s.age.tenant-acme')).toBe(0o600);
	});

	describe('a file written before scopes existed', () => {
		// produced by the previous release's `fileSecrets(...).set('node-key', 'legacy-value')`
		const LEGACY =
			'tNKRNQIiECzP2eEo7AryTRGnLGaFTdJi5idUr9U96zZw/KUcOI26cKkXvJa1zfdVwNs36gEiAfGXmbMlfynGzDEkGm921oLVTQKwyZ3j4XzB';
		const PHRASE = 'fixture-passphrase';

		function legacy() {
			const context = ctx();
			context.files.writeBytes('/s.age', new Uint8Array(Buffer.from(LEGACY, 'base64')));
			return context;
		}

		it('opens as the host scope', async () => {
			const store = fileSecrets(legacy(), '/s.age', PHRASE);
			expect(await store.get('node-key')).toBe('legacy-value');
			expect(await store.list()).toEqual([
				{ name: 'node-key', driver: 'file', updatedAt: 100 }
			]);
		});

		it('is left byte for byte alone by a tenant write', async () => {
			const context = legacy();
			const before = Buffer.from(context.files.readBytes('/s.age')).toString('base64');
			await fileSecrets(context, '/s.age', PHRASE).scope(tenantScope('acme')).set('A', 'b');
			expect(Buffer.from(context.files.readBytes('/s.age')).toString('base64')).toBe(before);
		});

		it('takes a host write in the same format, so an older release can still read it', async () => {
			const context = legacy();
			await fileSecrets(context, '/s.age', PHRASE).set('other', 'value');
			const store = fileSecrets(context, '/s.age', PHRASE);
			expect(await store.get('node-key')).toBe('legacy-value');
			expect(await store.get('other')).toBe('value');
		});
	});

	it('refuses a tenant secret name that is not an identifier', async () => {
		const store = fileSecrets(ctx(), '/s.age', PASSPHRASE).scope(tenantScope('acme'));
		for (const name of ['__proto__', 'a-b', 'a b', '1abc', '']) {
			await expect(store.set(name, 'x'), name).rejects.toThrow(/valid tenant secret name/);
		}
	});

	it('refuses a scope that is neither host nor a tenant name', () => {
		expect(() => tenantOfScope('tenant/../host')).toThrow(/not a secret scope/);
		expect(() => tenantOfScope('tenant/Acme')).toThrow(/not a secret scope/);
		expect(tenantOfScope('host')).toBe(null);
		expect(tenantOfScope('tenant/acme-2')).toBe('acme-2');
	});

	it('stays sealed in a narrowed store, and says so', async () => {
		const store = fileSecrets(ctx(), '/s.age', null).scope(tenantScope('acme'));
		expect(store.sealed()).toBe(true);
		await expect(store.list()).rejects.toThrow(/sealed/);
	});

	it('refuses a tenant scope on the drivers that cannot hold one', () => {
		expect(() => envSecrets(ctx()).scope(tenantScope('acme'))).toThrow(/host secrets only/);
		expect(() => keyringSecrets(ctx()).scope(tenantScope('acme'))).toThrow(/host secrets only/);
		expect(envSecrets(ctx()).scope('host').id()).toBe('env');
	});

	it('seals each kms scope in its own blob', async () => {
		const context = ctx();
		const client: KmsClient = {
			encrypt: async (plain) => new Uint8Array([0xaa, ...plain]),
			decrypt: async (sealed) => sealed.subarray(1)
		};
		const host = kmsSecrets(context, client, '/s.kms');
		await host.set('NODE_KEY', 'h');
		await host.scope(tenantScope('acme')).set('SMTP', 't');
		expect(context.files.exists('/s.kms.tenant-acme')).toBe(true);
		expect((await host.list()).map((ref) => ref.name)).toEqual(['NODE_KEY']);
		expect(await host.scope(tenantScope('acme')).get('NODE_KEY')).toBe(null);
	});

	it('never lists a value, whatever the scope', async () => {
		const store = fileSecrets(ctx(), '/s.age', PASSPHRASE).scope(tenantScope('acme'));
		await store.set('SMTP', 'topsecret-value');
		expect(JSON.stringify(await store.list())).not.toContain('topsecret-value');
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
