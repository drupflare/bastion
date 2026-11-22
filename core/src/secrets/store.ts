import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from 'node:crypto';
import type { Context } from '../context';
import { BastionError } from '../errors';

export interface SecretRef {
	name: string;
	/** which driver holds it, so a rotation knows where to write */
	driver: string;
	updatedAt: number;
}

/** the box's own secrets, such as the node key; what every unscoped call acts on */
export const HOST_SCOPE = 'host';

/** the scope one tenant's secrets live in, and the only one its workerd is ever given */
export const tenantScope = (tenant: string): string => `tenant/${tenant}`;

const TENANT_SCOPE = /^tenant\/([a-z0-9][a-z0-9-]{0,62})$/;

/** the tenant a scope belongs to, null for the host scope; anything else is refused */
export function tenantOfScope(scope: string): string | null {
	if (scope === HOST_SCOPE) return null;
	const match = TENANT_SCOPE.exec(scope);
	if (match === null) {
		throw new BastionError(
			'usage',
			`${scope} is not a secret scope; use host or tenant/<name>`
		);
	}
	return match[1] as string;
}

function refuseScope(driver: string, why: string): never {
	throw new BastionError(
		'driver-refused',
		`the ${driver} driver holds host secrets only: ${why}. Use the file or kms driver for a tenant's`
	);
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
 *
 * Every store acts on one scope, `host` unless narrowed. `scope()` returns the same store aimed
 * at another one, so a call site cannot reach across scopes by naming a secret.
 */
export interface SecretStore {
	id(): string;
	get(name: string): Promise<string | null>;
	set(name: string, value: string): Promise<void>;
	remove(name: string): Promise<void>;
	list(): Promise<SecretRef[]>;
	/** whether the store needs unsealing before it answers */
	sealed(): boolean;
	/** this store narrowed to `host` or `tenant/<name>` */
	scope(scope: string): SecretStore;
}

export function envSecrets(
	ctx: Context,
	prefix = 'BASTION_SECRET_',
	scope = HOST_SCOPE
): SecretStore {
	const key = (name: string): string =>
		`${prefix}${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
	if (tenantOfScope(scope) !== null) {
		refuseScope('env', 'a variable name cannot carry a scope without two tenants colliding');
	}
	return {
		id: () => 'env',
		sealed: () => false,
		scope: (next) => envSecrets(ctx, prefix, next),
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
	platform: string = process.platform,
	scope = HOST_SCOPE
): SecretStore {
	if (tenantOfScope(scope) !== null) {
		refuseScope(
			'keyring',
			"it cannot list a scope, so bastion could not bind a tenant's secrets"
		);
	}
	// a parameter rather than a direct `process.platform` read, matching `preflight`: the helper
	// differs per platform, so a test that scripts one of them passes on the machine that ships it
	// and answers the stub's empty default on the other
	const darwin = platform === 'darwin';
	return {
		id: () => 'keyring',
		sealed: () => false,
		scope: (next) => keyringSecrets(ctx, service, platform, next),
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
 * The names a tenant may give a secret.
 *
 * A tenant's secret becomes a binding on its worker, so the name is an identifier and not free
 * text. The leading letter also keeps `__proto__` and its kin out of the entry map.
 */
const TENANT_SECRET_NAME = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

function checkName(scope: string, name: string): void {
	if (tenantOfScope(scope) !== null && !TENANT_SECRET_NAME.test(name)) {
		throw new BastionError(
			'usage',
			`${name} is not a valid tenant secret name; use letters, digits and underscores, ` +
				'starting with a letter',
			{ next: null }
		);
	}
}

/** where a scope's file sits: the host keeps the configured path, a tenant gets a neighbour */
function scopePath(path: string, scope: string): string {
	const tenant = tenantOfScope(scope);
	return tenant === null ? path : `${path}.tenant-${tenant}`;
}

/**
 * An encrypted file, which is the driver an air-gapped install gets.
 *
 * XChaCha20-Poly1305 is not in node's cipher list, so this is AES-256-GCM: an AEAD with the same
 * properties for this use, shipped with the runtime, and requiring no dependency on a box that may
 * have no network to fetch one from. The nonce is fresh per write and stored beside the ciphertext.
 *
 * **One file per scope, one key per scope.** The host scope is the configured path in the format
 * every existing box already has, so nothing migrates and a first write cannot damage the node
 * key. A tenant's scope is a neighbouring file sealed under a key derived from the same
 * passphrase with HKDF, `info` being the scope, and the scope is also authenticated data. A tenant
 * file copied over another tenant's, or over the host's, fails to decrypt.
 */
export function fileSecrets(
	ctx: Context,
	path: string,
	passphrase: string | null,
	scope = HOST_SCOPE
): SecretStore {
	let unsealed = passphrase;
	const tenant = tenantOfScope(scope);
	const file = scopePath(path, scope);

	const keyFrom = (phrase: string): Buffer => {
		const held = derived.get(`${scope}\0${phrase}`);
		if (held !== undefined) return held;
		const base = scryptSync(phrase, SALT, 32);
		const key =
			tenant === null
				? base
				: Buffer.from(hkdfSync('sha256', base, SALT, `bastion-secret-scope:${scope}`, 32));
		derived.set(`${scope}\0${phrase}`, key);
		return key;
	};

	const read = (): Record<string, { value: string; updatedAt: number }> => {
		if (unsealed === null) {
			throw new BastionError('capability-refused', 'the secret file is sealed', {
				next: 'bastion secrets unseal'
			});
		}
		if (!ctx.files.exists(file)) return {};
		const raw = ctx.files.readBytes(file);
		const nonce = raw.subarray(0, 12);
		const tag = raw.subarray(12, 28);
		const body = raw.subarray(28);
		const decipher = createDecipheriv('aes-256-gcm', keyFrom(unsealed), nonce);
		if (tenant !== null) decipher.setAAD(Buffer.from(scope));
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
		if (tenant !== null) cipher.setAAD(Buffer.from(scope));
		const body = Buffer.concat([
			cipher.update(JSON.stringify(entries), 'utf8'),
			cipher.final()
		]);
		ctx.files.writeBytes(
			file,
			new Uint8Array(Buffer.concat([nonce, cipher.getAuthTag(), body]))
		);
		ctx.files.chmod(file, 0o600);
	};

	return {
		id: () => 'file',
		sealed: () => unsealed === null,
		scope: (next) => fileSecrets(ctx, path, unsealed, next),
		get: async (name) => {
			checkName(scope, name);
			return read()[name]?.value ?? null;
		},
		set: async (name, value) => {
			checkName(scope, name);
			const entries = read();
			entries[name] = { value, updatedAt: ctx.now() };
			write(entries);
		},
		remove: async (name) => {
			checkName(scope, name);
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

/**
 * Held in one KMS-sealed blob per scope, the host's at the configured path and a tenant's beside
 * it, so a tenant's secrets are never decrypted when the host's are read or the reverse.
 */
export function kmsSecrets(
	ctx: Context,
	client: KmsClient,
	configured: string,
	scope = HOST_SCOPE
): SecretStore {
	const path = scopePath(configured, scope);
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
		scope: (next) => kmsSecrets(ctx, client, configured, next),
		get: async (name) => {
			checkName(scope, name);
			return (await read())[name]?.value ?? null;
		},
		set: async (name, value) => {
			checkName(scope, name);
			const entries = await read();
			entries[name] = { value, updatedAt: ctx.now() };
			await write(entries);
		},
		remove: async (name) => {
			checkName(scope, name);
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
