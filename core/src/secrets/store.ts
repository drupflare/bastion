import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { Context } from '../context';
import { BastionError } from '../errors';

export interface SecretRef {
	name: string;
	/** which driver holds it, so a rotation knows where to write */
	driver: string;
	updatedAt: number;
}

/**
 * Where secrets live, which is never `bastion.yml`.
 *
 * Four drivers behind one contract. `kms` is a STRUCTURAL client contract rather than a named
 * vendor, so AWS KMS, GCP KMS, Vault and Azure Key Vault all satisfy it without bastion depending
 * on any of them.
 *
 * `get` returns the value and `list` never does. That asymmetry is the point: a settings form, a
 * `--json` payload and an audit line all call `list`, and none of them can accidentally carry a
 * secret because the method they have cannot produce one.
 */
export interface SecretStore {
	id(): string;
	get(name: string): Promise<string | null>;
	set(name: string, value: string): Promise<void>;
	remove(name: string): Promise<void>;
	list(): Promise<SecretRef[]>;
	/** whether the store needs unsealing before it answers */
	sealed(): boolean;
}

export function envSecrets(ctx: Context, prefix = 'BASTION_SECRET_'): SecretStore {
	const key = (name: string): string =>
		`${prefix}${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
	return {
		id: () => 'env',
		sealed: () => false,
		get: async (name) => ctx.env[key(name)] ?? null,
		set: async () => {
			throw new BastionError(
				'driver-refused',
				'the env driver is read-only; set the variable in the unit file or the shell that ' +
					'starts bastion'
			);
		},
		remove: async () => {
			throw new BastionError('driver-refused', 'the env driver is read-only');
		},
		list: async () =>
			Object.keys(ctx.env)
				.filter((k) => k.startsWith(prefix))
				.map((k) => ({
					name: k.slice(prefix.length).toLowerCase(),
					driver: 'env',
					updatedAt: 0
				}))
	};
}

/**
 * The OS keyring, through whichever helper the platform ships.
 *
 * `secret-tool` on Linux and `security` on macOS, both invoked through the command seam. A keyring
 * that is locked answers an error rather than an empty string, which is why `get` distinguishes a
 * missing entry from a failed call instead of collapsing both onto null.
 */
export function keyringSecrets(
	ctx: Context,
	service = 'bastion',
	platform: string = process.platform
): SecretStore {
	// a parameter rather than a direct `process.platform` read, matching `preflight`: the helper
	// differs per platform, so a test that scripts one of them passes on the machine that ships it
	// and answers the stub's empty default on the other
	const darwin = platform === 'darwin';
	return {
		id: () => 'keyring',
		sealed: () => false,
		get: async (name) => {
			const result = darwin
				? await ctx.runner.run('security', [
						'find-generic-password',
						'-s',
						service,
						'-a',
						name,
						'-w'
					])
				: await ctx.runner.run('secret-tool', ['lookup', 'service', service, 'name', name]);
			if (result.code === 0) return result.stdout.replace(/\n$/, '');
			if (/not be found|No such/i.test(result.stderr)) return null;
			throw new BastionError(
				'driver-unreachable',
				`the keyring answered: ${result.stderr.trim()}`,
				{
					retryable: true
				}
			);
		},
		set: async (name, value) => {
			const result = darwin
				? await ctx.runner.run('security', [
						'add-generic-password',
						'-U',
						'-s',
						service,
						'-a',
						name,
						'-w',
						value
					])
				: await ctx.runner.run(
						'secret-tool',
						[
							'store',
							'--label',
							`${service}:${name}`,
							'service',
							service,
							'name',
							name
						],
						{
							input: value
						}
					);
			if (result.code !== 0) {
				throw new BastionError(
					'driver-unreachable',
					`the keyring refused: ${result.stderr.trim()}`
				);
			}
		},
		remove: async (name) => {
			if (darwin) {
				await ctx.runner.run('security', [
					'delete-generic-password',
					'-s',
					service,
					'-a',
					name
				]);
			} else await ctx.runner.run('secret-tool', ['clear', 'service', service, 'name', name]);
		},
		list: async () => []
	};
}

const SALT = 'bastion-secret-file-v1';

// as in the backup packs: scrypt is meant to be slow, and re-deriving per read is pure waste
const derived = new Map<string, Buffer>();

/**
 * An encrypted file, which is the driver an air-gapped install gets.
 *
 * XChaCha20-Poly1305 is not in node's cipher list, so this is AES-256-GCM: an AEAD with the same
 * properties for this use, shipped with the runtime, and requiring no dependency on a box that may
 * have no network to fetch one from. The nonce is fresh per write and stored beside the ciphertext.
 */
export function fileSecrets(ctx: Context, path: string, passphrase: string | null): SecretStore {
	let unsealed = passphrase;

	const keyFrom = (phrase: string): Buffer => {
		const held = derived.get(phrase);
		if (held !== undefined) return held;
		const key = scryptSync(phrase, SALT, 32);
		derived.set(phrase, key);
		return key;
	};

	const read = (): Record<string, { value: string; updatedAt: number }> => {
		if (unsealed === null) {
			throw new BastionError('capability-refused', 'the secret file is sealed', {
				next: 'bastion secrets unseal'
			});
		}
		if (!ctx.files.exists(path)) return {};
		const raw = ctx.files.readBytes(path);
		const nonce = raw.subarray(0, 12);
		const tag = raw.subarray(12, 28);
		const body = raw.subarray(28);
		const decipher = createDecipheriv('aes-256-gcm', keyFrom(unsealed), nonce);
		decipher.setAuthTag(tag);
		try {
			const plain = Buffer.concat([decipher.update(body), decipher.final()]);
			return JSON.parse(plain.toString('utf8')) as Record<
				string,
				{ value: string; updatedAt: number }
			>;
		} catch {
			throw new BastionError(
				'capability-refused',
				'the secret file did not decrypt with that passphrase'
			);
		}
	};

	const write = (entries: Record<string, { value: string; updatedAt: number }>): void => {
		if (unsealed === null)
			throw new BastionError('capability-refused', 'the secret file is sealed');
		const nonce = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', keyFrom(unsealed), nonce);
		const body = Buffer.concat([
			cipher.update(JSON.stringify(entries), 'utf8'),
			cipher.final()
		]);
		ctx.files.writeBytes(
			path,
			new Uint8Array(Buffer.concat([nonce, cipher.getAuthTag(), body]))
		);
		ctx.files.chmod(path, 0o600);
	};

	return {
		id: () => 'file',
		sealed: () => unsealed === null,
		get: async (name) => read()[name]?.value ?? null,
		set: async (name, value) => {
			const entries = read();
			entries[name] = { value, updatedAt: ctx.now() };
			write(entries);
		},
		remove: async (name) => {
			const entries = read();
			delete entries[name];
			write(entries);
		},
		list: async () =>
			Object.entries(read()).map(([name, entry]) => ({
				name,
				driver: 'file',
				updatedAt: entry.updatedAt
			}))
	};
}

/**
 * The shape a KMS has to satisfy.
 *
 * Structural, so AWS KMS, GCP KMS, Vault's transit engine and Azure Key Vault all fit. bastion
 * stores only the ciphertext and never the data key, so a stolen bastion disk is a set of blobs
 * that need a call to someone else's service to open.
 */
export interface KmsClient {
	encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
	decrypt(ciphertext: Uint8Array): Promise<Uint8Array>;
}

export function kmsSecrets(ctx: Context, client: KmsClient, path: string): SecretStore {
	const read = async (): Promise<Record<string, { value: string; updatedAt: number }>> => {
		if (!ctx.files.exists(path)) return {};
		const plain = await client.decrypt(ctx.files.readBytes(path));
		return JSON.parse(new TextDecoder().decode(plain)) as Record<
			string,
			{ value: string; updatedAt: number }
		>;
	};
	const write = async (
		entries: Record<string, { value: string; updatedAt: number }>
	): Promise<void> => {
		const sealed = await client.encrypt(new TextEncoder().encode(JSON.stringify(entries)));
		ctx.files.writeBytes(path, sealed);
		ctx.files.chmod(path, 0o600);
	};
	return {
		id: () => 'kms',
		sealed: () => false,
		get: async (name) => (await read())[name]?.value ?? null,
		set: async (name, value) => {
			const entries = await read();
			entries[name] = { value, updatedAt: ctx.now() };
			await write(entries);
		},
		remove: async (name) => {
			const entries = await read();
			delete entries[name];
			await write(entries);
		},
		list: async () =>
			Object.entries(await read()).map(([name, entry]) => ({
				name,
				driver: 'kms',
				updatedAt: entry.updatedAt
			}))
	};
}

export interface SecretClients {
	kms?: KmsClient;
}

export function buildSecrets(
	ctx: Context,
	config: { driver: string; [key: string]: unknown },
	clients: SecretClients = {}
): SecretStore {
	switch (config.driver) {
		case 'env':
			return envSecrets(ctx, String(config.prefix ?? 'BASTION_SECRET_'));
		case 'keyring':
			return keyringSecrets(ctx, String(config.service ?? 'bastion'));
		case 'file':
			return fileSecrets(
				ctx,
				String(config.path ?? '/var/lib/bastion/secrets/secrets.age'),
				(ctx.env.BASTION_SECRET_PASSPHRASE ?? null) as string | null
			);
		case 'kms':
			if (clients.kms === undefined) {
				throw new BastionError(
					'driver-refused',
					'the kms secrets driver needs a client; pass one rather than having bastion choose ' +
						'a vendor for you'
				);
			}
			return kmsSecrets(
				ctx,
				clients.kms,
				String(config.path ?? '/var/lib/bastion/secrets/secrets.kms')
			);
		default:
			throw new BastionError('driver-refused', `unknown secrets driver ${config.driver}`);
	}
}

/** the redaction every printer runs before anything reaches stdout or a log */
export function redact(value: unknown): unknown {
	if (typeof value === 'string') return value === '' ? '' : '(redacted)';
	if (Array.isArray(value)) return value.map(redact);
	if (typeof value === 'object' && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) out[key] = redact(entry);
		return out;
	}
	return value;
}
