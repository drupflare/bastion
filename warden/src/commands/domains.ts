import type { BastionConfig, Context, ListenerHost, Strategy } from '@drupflare/bastion';
import {
	BastionError,
	CertificateStore,
	acmeConfigured,
	allocate,
	assertChain,
	backupTarget,
	bunListenerHost,
	challengeName,
	challengeToken,
	checkChain,
	checkDomain,
	chooseStrategy,
	cloudflareProvider,
	generateKey,
	isUnderPrimary,
	issueAndStore,
	nodeResolver,
	renewable,
	selfSigned,
	suggest,
	writeConfig,
	type DnsProvider,
	type PrimaryDomain
} from '@drupflare/bastion';
import { kv, table } from '../format';
import { emit, load, type Globals } from '../state';

function primaryOf(config: {
	domains?: { primary?: string; reserved?: string[] };
}): PrimaryDomain | null {
	const primary = config.domains?.primary;
	if (primary === undefined || primary === '') return null;
	return {
		domain: primary,
		...(config.domains?.reserved === undefined ? {} : { reserved: config.domains.reserved })
	};
}

function providerFor(
	ctx: Context,
	config: { domains?: { provider?: { driver: string; [k: string]: unknown } } }
): DnsProvider | null {
	const configured = config.domains?.provider;
	if (configured === undefined || configured.driver === 'none') return null;
	if (configured.driver === 'cloudflare') {
		const apiToken = String(configured.apiToken ?? ctx.env.CLOUDFLARE_API_TOKEN ?? '');
		if (apiToken === '') {
			throw new BastionError(
				'config-invalid',
				'the cloudflare DNS provider needs a token. Set `domains.provider.apiToken` or ' +
					'CLOUDFLARE_API_TOKEN, scoped to Zone.DNS edit on the zones bastion manages',
				{ next: 'bastion config validate' }
			);
		}
		return cloudflareProvider(ctx, {
			apiToken,
			...(Array.isArray(configured.zones) ? { zones: configured.zones as string[] } : {})
		});
	}
	throw new BastionError('config-invalid', `unknown DNS provider ${configured.driver}`);
}

/** the install secret the ownership token is derived from; per state directory, never per run */
function installSecret(ctx: Context, state: string): string {
	const path = `${state}/domain-secret`;
	if (ctx.files.exists(path)) return ctx.files.readText(path).trim();
	const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
	ctx.files.writeText(path, secret);
	ctx.files.chmod(path, 0o600);
	return secret;
}

export function runDomainList(ctx: Context, globals: Globals): void {
	const loaded = load(ctx, globals);
	const primary = primaryOf(loaded.config);
	const rows = loaded.config.tenants.flatMap((tenant) =>
		tenant.sites.flatMap((site) =>
			[site.host, ...(site.aliases ?? [])].map((host) => ({
				host,
				tenant: tenant.name,
				kind: host === site.host ? 'primary' : 'alias',
				managed: primary !== null && isUnderPrimary(host, primary),
				verifiedAt: site.verifiedAt ?? null
			}))
		)
	);
	emit(ctx, globals, { primary: primary?.domain ?? null, domains: rows }, () =>
		rows.length === 0
			? 'no domains are configured'
			: table(
					['domain', 'tenant', 'kind', 'under primary', 'verified'],
					rows.map((row) => [
						row.host,
						row.tenant,
						row.kind,
						row.managed ? 'yes' : 'no',
						row.verifiedAt === null
							? '-'
							: new Date(row.verifiedAt).toISOString().slice(0, 10)
					])
				)
	);
}

/**
 * Allocates a name under the primary domain, or accepts a custom root where that is allowed.
 *
 * A name under the primary domain needs no ownership proof, because the institution already owns
 * the zone. A custom root does, and is refused outright unless the operator turned it on.
 */
export function runDomainAdd(
	ctx: Context,
	globals: Globals & { tenant?: string; alias?: string },
	nameOrHost: string
): void {
	const loaded = load(ctx, globals);
	const primary = primaryOf(loaded.config);
	const tenantName = globals.tenant ?? loaded.config.tenants[0]?.name;
	const tenant = loaded.config.tenants.find((entry) => entry.name === tenantName);
	if (tenant === undefined) {
		throw new BastionError('usage', 'name a tenant with --tenant', {
			next: 'bastion tenant list'
		});
	}

	const taken = loaded.config.tenants.flatMap((entry) =>
		entry.sites.flatMap((site) => [site.host, ...(site.aliases ?? [])])
	);
	const custom = nameOrHost.includes('.');
	if (custom && (primary === null || !isUnderPrimary(nameOrHost, primary))) {
		if (loaded.config.domains?.allowCustomRoots !== true) {
			throw new BastionError(
				'capability-refused',
				`${nameOrHost} is not under the primary domain, and custom roots are off. Turn on ` +
					'`domains.allowCustomRoots` to accept names this institution does not already own',
				{ next: 'bastion config set domains.allowCustomRoots true' }
			);
		}
	}

	const host = custom
		? nameOrHost.toLowerCase()
		: primary === null
			? (() => {
					throw new BastionError(
						'usage',
						'no primary domain is configured, so a bare name cannot be allocated',
						{ next: 'bastion config set domains.primary sites.example.edu' }
					);
				})()
			: allocate(nameOrHost, primary, taken);

	const alias = globals.alias;
	const config = {
		...loaded.config,
		tenants: loaded.config.tenants.map((entry) => {
			if (entry.name !== tenantName) return entry;
			if (alias !== undefined) {
				return {
					...entry,
					sites: entry.sites.map((site) =>
						site.host === alias
							? { ...site, aliases: [...(site.aliases ?? []), host] }
							: site
					)
				};
			}
			return {
				...entry,
				sites: [...entry.sites, { host, bundle: './payload.tar.gz', probe: 'drupflare' }]
			};
		})
	};
	writeConfig(ctx, loaded.path ?? `${ctx.cwd}/bastion.yml`, config);
	emit(ctx, globals, { host, tenant: tenantName, alias: alias ?? null }, () =>
		alias === undefined
			? `allocated ${host} to ${tenantName}`
			: `added ${host} as an alias of ${alias}`
	);
}

export function runDomainSuggest(ctx: Context, globals: Globals, preferred: string): void {
	const loaded = load(ctx, globals);
	const primary = primaryOf(loaded.config);
	if (primary === null) {
		throw new BastionError('usage', 'no primary domain is configured');
	}
	const taken = loaded.config.tenants.flatMap((entry) =>
		entry.sites.flatMap((site) => [site.host, ...(site.aliases ?? [])])
	);
	const host = suggest(preferred, primary, taken);
	emit(ctx, globals, { host }, () => host);
}

export async function runDomainVerify(
	ctx: Context,
	globals: Globals & { tenant?: string },
	host: string
): Promise<number> {
	const loaded = load(ctx, globals);
	const primary = primaryOf(loaded.config);
	const owner =
		loaded.config.tenants.find((tenant) =>
			tenant.sites.some((site) => site.host === host || (site.aliases ?? []).includes(host))
		)?.name ?? globals.tenant;
	if (owner === undefined) {
		throw new BastionError('usage', `no tenant holds ${host}`, { next: 'bastion domain list' });
	}

	const report = await checkDomain(
		nodeResolver(),
		installSecret(ctx, loaded.state),
		owner,
		host,
		{
			addresses: loaded.config.domains?.addresses ?? [],
			caaIdentity: 'letsencrypt.org',
			requireOwnership: primary === null || !isUnderPrimary(host, primary)
		}
	);

	emit(ctx, globals, report, () =>
		[
			table(
				['check', 'state', 'detail'],
				report.checks.map((check) => [check.id, check.state, check.detail])
			),
			...(report.instructions.length === 0
				? []
				: ['', 'publish these records:', ...report.instructions.map((line) => `  ${line}`)])
		].join('\n')
	);
	return report.ready ? 0 : 3;
}

export function runDomainToken(
	ctx: Context,
	globals: Globals & { tenant?: string },
	host: string
): void {
	const loaded = load(ctx, globals);
	const owner =
		loaded.config.tenants.find((tenant) =>
			tenant.sites.some((site) => site.host === host || (site.aliases ?? []).includes(host))
		)?.name ?? globals.tenant;
	if (owner === undefined) throw new BastionError('usage', `no tenant holds ${host}`);
	const token = challengeToken(installSecret(ctx, loaded.state), owner, host);
	emit(
		ctx,
		globals,
		{ host, tenant: owner, name: challengeName(host), value: token },
		() => `TXT ${challengeName(host)} "${token}"`
	);
}

/**
 * The ACME account key, kept per state directory.
 *
 * A fresh key registers a fresh account, and Let's Encrypt allows 10 new accounts per IP per 3
 * hours. A renewal loop that generated one each run would work in a lab and stop working on the
 * box with the most certificates on it.
 */
function accountKey(ctx: Context, state: string): string {
	const path = `${state}/certs/acme-account.key`;
	if (ctx.files.exists(path)) return ctx.files.readText(path);
	const key = generateKey().privateKeyPem;
	ctx.files.writeText(path, key);
	ctx.files.chmod(path, 0o600);
	return key;
}

const ACME_STRATEGIES = new Set<Strategy>(['acme-http-01', 'acme-dns-01', 'acme-dns-01-manual']);

/** the command that applies when the chosen strategy is not an ACME one */
const INSTEAD: Record<string, string> = {
	imported: 'bastion cert import',
	'local-ca': 'bastion cert self-sign',
	'self-signed': 'bastion cert self-sign'
};

export interface IssueOptions {
	staging?: boolean;
	force?: boolean;
	/** the manual DNS-01 path polls for the record; short in a test */
	watchAttempts?: number;
	listenerHost?: ListenerHost | null;
	/** the poll delay between ACME states; real in a run, immediate in the gate lane */
	sleep?(ms: number): Promise<void>;
}

/**
 * Runs one ACME order for a host and installs the result.
 *
 * Shared by `cert issue` and `cert renew` so the two cannot disagree about which strategy a name
 * gets. The strategy is chosen from the same inputs `cert plan` prints, so a plan that says
 * `acme-dns-01` is the order that runs.
 */
export async function issueFor(
	ctx: Context,
	loaded: { config: BastionConfig; state: string },
	host: string,
	options: IssueOptions = {}
): Promise<{
	host: string;
	strategy: Strategy;
	manual: boolean;
	hosts: string[];
	expiresAt: number;
}> {
	const store = new CertificateStore(ctx, `${loaded.state}/certs`);
	const primary = primaryOf(loaded.config);
	const provider = providerFor(ctx, loaded.config);
	const existing = store.load(host);

	const choice = chooseStrategy({
		host,
		acmeConfigured: acmeConfigured(loaded.config),
		provider,
		primary,
		existing: options.force === true ? null : existing,
		localCaAvailable: ctx.files.exists(`${loaded.state}/certs/local-ca.pem`)
	});
	if (!ACME_STRATEGIES.has(choice.strategy)) {
		throw new BastionError(
			'capability-refused',
			`${host} cannot be issued over ACME: ${choice.reason}`,
			{ next: INSTEAD[choice.strategy] ?? 'bastion cert plan' }
		);
	}

	const site = loaded.config.tenants
		.flatMap((tenant) => tenant.sites)
		.find((entry) => entry.host === host);
	const hosts = site === undefined ? [host] : [site.host, ...(site.aliases ?? [])];

	const acme = (loaded.config.tls as { acme?: { email?: string; ca?: string } } | undefined)
		?.acme;
	const { result, stored } = await issueAndStore(ctx, store, {
		hosts,
		strategy: choice.strategy,
		email: acme?.email as string,
		ca: options.staging === true ? 'letsencrypt-staging' : (acme?.ca ?? 'letsencrypt'),
		accountKeyPem: accountKey(ctx, loaded.state),
		provider,
		resolver: nodeResolver(),
		listenerHost:
			options.listenerHost === undefined
				? choice.strategy === 'acme-http-01'
					? bunListenerHost()
					: null
				: options.listenerHost,
		...(options.watchAttempts === undefined ? {} : { watchAttempts: options.watchAttempts }),
		...(options.sleep === undefined ? {} : { sleep: options.sleep })
	});

	return {
		host,
		strategy: result.strategy,
		manual: result.manual,
		hosts: stored.hosts,
		expiresAt: stored.expiresAt
	};
}

/** obtains a certificate from a CA over ACME and installs it */
export async function runCertIssue(
	ctx: Context,
	globals: Globals & IssueOptions,
	host: string
): Promise<void> {
	const loaded = load(ctx, globals);
	const issued = await issueFor(ctx, loaded, host, globals);
	emit(ctx, globals, issued, () =>
		kv([
			['issued', issued.host],
			['covers', issued.hosts.join(', ')],
			['over', issued.strategy],
			['expires', new Date(issued.expiresAt).toISOString()]
		])
	);
}

/** what would issue this name, and why, without asking a CA for anything */
export function runCertPlan(ctx: Context, globals: Globals, host: string): void {
	const loaded = load(ctx, globals);
	const store = new CertificateStore(ctx, `${loaded.state}/certs`);
	const primary = primaryOf(loaded.config);
	let provider: DnsProvider | null = null;
	try {
		provider = providerFor(ctx, loaded.config);
	} catch {
		provider = null;
	}
	const choice = chooseStrategy({
		host,
		acmeConfigured: acmeConfigured(loaded.config),
		provider,
		primary,
		existing: store.load(host),
		localCaAvailable: ctx.files.exists(`${loaded.state}/certs/local-ca.pem`)
	});
	emit(ctx, globals, choice, () =>
		kv([
			['host', host],
			['strategy', choice.strategy],
			['because', choice.reason],
			['needs you', choice.needsOperator ? 'yes' : 'no'],
			['next', choice.instruction ?? '(nothing)']
		])
	);
}

/** installs a chain an operator got from their own CA, after checking it */
export function runCertImport(
	ctx: Context,
	globals: Globals & { key?: string },
	host: string,
	chainPath: string
): void {
	const loaded = load(ctx, globals);
	const keyPath = globals.key ?? chainPath.replace(/\.(pem|crt|cer)$/, '.key');
	if (!ctx.files.exists(chainPath)) throw new BastionError('usage', `${chainPath} is not there`);
	if (!ctx.files.exists(keyPath)) {
		throw new BastionError('usage', `${keyPath} is not there; name it with --key`);
	}
	const certificatePem = ctx.files.readText(chainPath);
	const privateKeyPem = ctx.files.readText(keyPath);

	const site = loaded.config.tenants
		.flatMap((tenant) => tenant.sites)
		.find((entry) => entry.host === host || (entry.aliases ?? []).includes(host));
	const names = site === undefined ? [host] : [site.host, ...(site.aliases ?? [])];

	const report = checkChain(certificatePem, privateKeyPem, names, ctx.now());
	assertChain(report, host);

	new CertificateStore(ctx, `${loaded.state}/certs`).save(host, {
		hosts: report.hosts,
		certificatePem,
		privateKeyPem,
		issuedAt: report.notBefore,
		expiresAt: report.notAfter,
		source: 'imported'
	});

	for (const problem of report.problems) ctx.io.err(`warning: ${problem.detail}`);
	emit(ctx, globals, { host, ...report, problems: report.problems }, () =>
		kv([
			['installed', host],
			['covers', report.hosts.join(', ')],
			['issuer', report.issuer],
			['expires', new Date(report.notAfter).toISOString()],
			['renewal', renewable({ ...report, source: 'imported' } as never).reason]
		])
	);
}

/** a self-signed certificate, for a lab or a name no public CA will issue for */
export function runCertSelfSign(ctx: Context, globals: Globals, host: string): void {
	const loaded = load(ctx, globals);
	const site = loaded.config.tenants
		.flatMap((tenant) => tenant.sites)
		.find((entry) => entry.host === host);
	const names = site === undefined ? [host] : [site.host, ...(site.aliases ?? [])];
	const made = selfSigned(names, { now: ctx.now() });
	new CertificateStore(ctx, `${loaded.state}/certs`).save(host, {
		hosts: names,
		certificatePem: made.certificatePem,
		privateKeyPem: made.privateKeyPem,
		issuedAt: ctx.now(),
		expiresAt: ctx.now() + 90 * 86_400_000,
		source: 'local'
	});
	ctx.io.err(
		'this certificate is signed by nobody. Every client will warn until it is trusted ' +
			'deliberately, and it lasts 90 days on purpose'
	);
	emit(ctx, globals, { host, hosts: names, days: 90 }, () => `self-signed ${names.join(', ')}`);
}

void backupTarget;
