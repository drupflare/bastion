import { ACKNOWLEDGE_FLAG } from '@drupflare/bastion';
export interface OptionSpec {
	flags: string;
	description: string;
	/** shown in the generated reference; a default nobody can see is a default nobody trusts */
	defaultValue?: string;
}

export interface CommandSpec {
	group: string;
	/** the command path after `bastion`, e.g. `config show` */
	name: string;
	description: string;
	args?: { name: string; required: boolean; description: string }[];
	options?: OptionSpec[];
	/** the exit codes this command can produce beyond 0 and 1 */
	exits?: { code: number; when: string }[];
	/** the manual section it is documented in; `check:reachability` walks this */
	manual: string;
	/** false for anything that needs a running bastion, so the gate can skip it honestly */
	offline?: boolean;
	/** the dashboard route that surfaces this command, or null with `exempt` saying why not */
	surface?: string | null;
	/** why this command has no dashboard surface; a stale exemption fails the check too */
	exempt?: string;
}

const JSON_EXIT = { code: 2, when: 'the input or the configuration is wrong' };
const FINDING_EXIT = { code: 3, when: 'the check ran and found something' };

/**
 * Every command, as data.
 *
 * `docs/commands.md` is generated from this table and CI fails when it drifts, so the reference
 * cannot disagree with the program the way a hand-written list does. That is the same failure the
 * worker's cache-tier list produced: a hand-written enumeration of what the code emits was wrong
 * six entries out of ten, and the fix was one const asserted in both directions.
 */
export const COMMANDS: CommandSpec[] = [
	// lifecycle
	{
		group: 'lifecycle',
		name: 'init',
		description: 'write a bastion.yml and the state directory',
		manual: 'getting-started',
		offline: true,
		options: [{ flags: '--force', description: 'overwrite an existing bastion.yml' }],
		exits: [JSON_EXIT],
		surface: null,
		exempt: 'there is no dashboard until bastion has been initialised'
	},
	{
		group: 'lifecycle',
		name: 'up',
		description: 'start every tenant, the front door and the dashboard',
		manual: 'running',
		options: [
			{ flags: '--no-dashboard', description: 'do not start the management listener' },
			{ flags: '--mode <mode>', description: 'solo, hardened or isolated' },
			{
				flags: ACKNOWLEDGE_FLAG,
				description: 'accept that this mode puts no security boundary between tenants'
			}
		],
		exits: [JSON_EXIT],
		surface: null,
		exempt: 'the dashboard cannot start itself'
	},
	{
		group: 'lifecycle',
		name: 'down',
		description: 'stop every tenant and the front door',
		manual: 'running',
		surface: null,
		exempt: 'the dashboard cannot stop the process serving it'
	},
	{
		group: 'lifecycle',
		name: 'restart',
		description: 'stop and start, keeping the configuration',
		manual: 'running',
		options: [
			{
				flags: ACKNOWLEDGE_FLAG,
				description: 'accept that this mode puts no security boundary between tenants'
			}
		],
		surface: null,
		exempt: 'the dashboard cannot restart the process serving it'
	},
	{
		group: 'lifecycle',
		name: 'reload',
		description: 'swap the tenants whose configuration changed, leaving the rest resident',
		manual: 'running',
		options: [
			{
				flags: '--check',
				description: 'report what is out of date and change nothing'
			}
		],
		exits: [FINDING_EXIT],
		surface: '/'
	},
	{
		group: 'lifecycle',
		name: 'serve',
		description: 'run in the foreground; what a unit file calls',
		manual: 'running',
		options: [
			{ flags: '--mode <mode>', description: 'solo, hardened or isolated' },
			{
				flags: ACKNOWLEDGE_FLAG,
				description: 'accept that this mode puts no security boundary between tenants'
			}
		],
		surface: null,
		exempt: 'a foreground process is what a unit file calls, not a browser'
	},

	// inspect
	{
		group: 'inspect',
		name: 'status',
		description: 'what is running, per tenant and per site',
		manual: 'running',
		exits: [FINDING_EXIT],
		surface: '/'
	},
	{
		group: 'inspect',
		name: 'doctor',
		description: 'what this host can and cannot do, and which limits are enforced',
		manual: 'diagnosing',
		offline: true,
		exits: [FINDING_EXIT],
		surface: '/'
	},
	{
		group: 'inspect',
		name: 'capability list',
		description:
			'every optional binding, whether its primitive is installed, and what installs it',
		manual: 'diagnosing',
		offline: true,
		exits: [JSON_EXIT],
		surface: '/'
	},
	{
		group: 'inspect',
		name: 'capability install',
		description: 'install the host software one optional binding needs',
		manual: 'diagnosing',
		args: [{ name: 'slot', required: true, description: 'images or browser' }],
		exits: [JSON_EXIT],
		surface: '/'
	},
	{
		group: 'inspect',
		name: 'health',
		description: 'the health tree and every open finding',
		manual: 'diagnosing',
		options: [{ flags: '--tree', description: 'render as a tree rather than a list' }],
		exits: [FINDING_EXIT],
		surface: '/health'
	},
	{
		group: 'inspect',
		name: 'diagnose',
		description: 'explain one finding and what bastion already did about it',
		manual: 'diagnosing',
		args: [{ name: 'code', required: false, description: 'a tripwire code' }],
		options: [
			{ flags: '--since <duration>', description: 'only findings newer than this' },
			{ flags: '--code <code>', description: 'the tripwire to explain' }
		],
		surface: '/health'
	},
	{
		group: 'inspect',
		name: 'metrics',
		description: 'the Prometheus exposition this node serves',
		manual: 'observing',
		surface: '/'
	},
	{
		group: 'inspect',
		name: 'logs',
		description: 'read the structured logs',
		manual: 'observing',
		options: [
			{ flags: '--tenant <name>', description: 'one tenant only' },
			{
				flags: '--level <level>',
				description: 'debug, info, warn, error or critical',
				defaultValue: 'info'
			},
			{ flags: '--node <id|all>', description: 'proxy to another node, or every node' },
			{ flags: '--since <duration>', description: 'only lines newer than this' }
		],
		surface: '/logs'
	},
	{
		group: 'inspect',
		name: 'tail',
		description: 'follow the logs as they are written',
		manual: 'observing',
		options: [{ flags: '--tenant <name>', description: 'one tenant only' }],
		surface: '/logs'
	},
	{
		group: 'inspect',
		name: 'capacity',
		description: 'what this host holds, with each input s provenance',
		manual: 'capacity',
		offline: true,
		options: [
			{ flags: '--node <id>', description: 'another node in the cluster' },
			{ flags: '--tenant <name>', description: 'one tenant s share' },
			{ flags: '--what-if <n>', description: 'the answer at n sites' }
		],
		surface: '/'
	},

	// config
	{
		group: 'config',
		name: 'config show',
		description: 'the effective configuration, defaults merged',
		manual: 'configuration',
		offline: true,
		surface: '/config'
	},
	{
		group: 'config',
		name: 'config where',
		description: 'every value the file set, and where it came from',
		manual: 'configuration',
		offline: true,
		surface: '/config'
	},
	{
		group: 'config',
		name: 'config get',
		description: 'print the value of one key',
		manual: 'configuration',
		offline: true,
		args: [{ name: 'key', required: true, description: 'a dotted path' }],
		surface: '/config'
	},
	{
		group: 'config',
		name: 'config set',
		description: 'write one key back through the validator the UI uses',
		manual: 'configuration',
		offline: true,
		args: [
			{ name: 'key', required: true, description: 'a dotted path' },
			{ name: 'value', required: true, description: 'the new value' }
		],
		exits: [JSON_EXIT],
		surface: '/config'
	},
	{
		group: 'config',
		name: 'config validate',
		description: 'check the file and report the path of every rejection',
		manual: 'configuration',
		offline: true,
		exits: [JSON_EXIT],
		surface: '/config'
	},
	{
		group: 'config',
		name: 'config schema',
		description: 'print the JSON Schema an editor completes from',
		manual: 'configuration',
		offline: true,
		surface: '/config'
	},
	{
		group: 'config',
		name: 'config edit',
		description: 'open the file in $EDITOR and validate on save',
		manual: 'configuration',
		offline: true,
		surface: '/config'
	},

	// tenants and sites
	{
		group: 'tenants',
		name: 'tenant list',
		description: 'every tenant and its limits',
		manual: 'tenants',
		surface: '/tenants'
	},
	{
		group: 'tenants',
		name: 'tenant add',
		description: 'create a tenant',
		manual: 'tenants',
		args: [{ name: 'name', required: true, description: 'the tenant name' }],
		options: [
			{ flags: '--cpu <cores>', description: 'the cgroup cpu quota' },
			{ flags: '--memory <bytes>', description: 'the cgroup memory limit' },
			{ flags: '--max-sites <n>', description: 'the provisioning ceiling' }
		],
		surface: '/tenants'
	},
	{
		group: 'tenants',
		name: 'tenant show',
		description: 'one tenant, with its capabilities and their enforcement points',
		manual: 'tenants',
		args: [{ name: 'name', required: true, description: 'the tenant name' }],
		surface: '/tenants'
	},
	{
		group: 'tenants',
		name: 'tenant rm',
		description: 'remove a tenant',
		manual: 'tenants',
		args: [{ name: 'name', required: true, description: 'the tenant name' }],
		options: [
			{
				flags: '--purge',
				description: 'delete its state as well; refuses without --yes and a verified backup'
			}
		],
		surface: '/tenants'
	},
	{
		group: 'tenants',
		name: 'tenant suspend',
		description: 'stop a tenant and serve a maintenance page',
		manual: 'tenants',
		args: [{ name: 'name', required: true, description: 'the tenant name' }],
		surface: '/tenants'
	},
	{
		group: 'tenants',
		name: 'tenant resume',
		description: 'bring a suspended tenant back',
		manual: 'tenants',
		args: [{ name: 'name', required: true, description: 'the tenant name' }],
		surface: '/tenants'
	},
	{
		group: 'tenants',
		name: 'tenant limits',
		description: 'read or set a tenant s cgroup limits',
		manual: 'tenants',
		args: [{ name: 'name', required: true, description: 'the tenant name' }],
		options: [
			{ flags: '--cpu <cores>', description: 'the cgroup cpu quota' },
			{ flags: '--memory <bytes>', description: 'the cgroup memory limit' },
			{ flags: '--pids <n>', description: 'the process limit' },
			{ flags: '--max-sites <n>', description: 'the provisioning ceiling' }
		],
		exits: [JSON_EXIT],
		surface: '/tenants'
	},
	{
		group: 'tenants',
		name: 'tenant egress',
		description: 'read or set a tenant s egress allow list',
		manual: 'egress',
		args: [{ name: 'name', required: true, description: 'the tenant name' }],
		surface: '/tenants'
	},
	{
		group: 'sites',
		name: 'site list',
		description: 'every site and the tenant holding it',
		manual: 'sites',
		surface: '/tenants'
	},
	{
		group: 'sites',
		name: 'site add',
		description: 'add a site to a tenant',
		manual: 'sites',
		args: [{ name: 'host', required: true, description: 'the hostname' }],
		options: [
			{ flags: '--tenant <name>', description: 'the tenant to add it to' },
			{ flags: '--bundle <path|url>', description: 'the site payload' },
			{
				flags: '--template <path|url>',
				description: 'pull a worker template and read its bindings from its manifest'
			},
			{ flags: '--probe <profile>', description: 'the profile that proves a boot' },
			{
				flags: '--checksum <sha256>',
				description: 'the digest a download must hash to'
			},
			{
				flags: '--insecure-source',
				description: 'accept a plaintext download, or one on this network'
			}
		],
		exits: [JSON_EXIT],
		surface: '/tenants'
	},
	{
		group: 'sites',
		name: 'site template',
		description: 'read a worker template and report what bastion would and would not carry',
		manual: 'sites',
		args: [{ name: 'source', required: true, description: 'a url or a directory' }],
		options: [
			{
				flags: '--checksum <sha256>',
				description: 'the digest a download must hash to'
			},
			{
				flags: '--insecure-source',
				description: 'accept a plaintext download, or one on this network'
			}
		],
		exits: [JSON_EXIT],
		surface: '/tenants'
	},
	{
		group: 'sites',
		name: 'site show',
		description: 'one site, with its placement and its meters',
		manual: 'sites',
		args: [{ name: 'host', required: true, description: 'the hostname' }],
		surface: '/tenants'
	},
	{
		group: 'sites',
		name: 'site rm',
		description: 'remove a site',
		manual: 'sites',
		args: [{ name: 'host', required: true, description: 'the hostname' }],
		surface: '/tenants'
	},
	{
		group: 'sites',
		name: 'site probe',
		description: 'ask this box to serve the site and report what came back',
		manual: 'sites',
		args: [{ name: 'host', required: true, description: 'the hostname' }],
		options: [
			{
				flags: '--public',
				description: 'resolve the hostname instead, checking dns and the certificate too'
			}
		],
		exits: [FINDING_EXIT],
		surface: '/tenants'
	},

	// delivery
	{
		group: 'delivery',
		name: 'deploy',
		description: 'upload a bundle and point the site at it',
		manual: 'deploying',
		args: [
			{ name: 'host', required: true, description: 'the hostname' },
			{
				name: 'bundle',
				required: true,
				description: 'the payload to upload, a path or a url'
			}
		],
		options: [
			{
				flags: '--checksum <sha256>',
				description: 'the digest a download must hash to'
			},
			{
				flags: '--insecure-source',
				description: 'accept a plaintext download, or one on this network'
			}
		],
		surface: '/tenants'
	},
	{
		group: 'delivery',
		name: 'versions list',
		description: 'every version of a site',
		manual: 'deploying',
		args: [{ name: 'host', required: true, description: 'the hostname' }],
		surface: '/tenants'
	},
	{
		group: 'delivery',
		name: 'versions show',
		description: 'one version',
		manual: 'deploying',
		args: [
			{ name: 'host', required: true, description: 'the hostname' },
			{ name: 'id', required: true, description: 'the version id' }
		],
		surface: '/tenants'
	},
	{
		group: 'delivery',
		name: 'versions diff',
		description: 'what changed between two versions',
		manual: 'deploying',
		args: [
			{ name: 'host', required: true, description: 'the hostname' },
			{ name: 'from', required: true, description: 'a version id' },
			{ name: 'to', required: true, description: 'a version id' }
		],
		surface: '/tenants'
	},
	{
		group: 'delivery',
		name: 'versions pin',
		description: 'hold a version so retention cannot remove it',
		manual: 'deploying',
		args: [
			{ name: 'host', required: true, description: 'the hostname' },
			{ name: 'id', required: true, description: 'the version id' }
		],
		surface: '/tenants'
	},
	{
		group: 'delivery',
		name: 'rollout',
		description: 'send a share of traffic to a version',
		manual: 'deploying',
		args: [{ name: 'host', required: true, description: 'the hostname' }],
		options: [
			{ flags: '--version <id>', description: 'the version to send traffic to' },
			{ flags: '--percent <n>', description: 'the share, 0 to 100' }
		],
		surface: '/tenants'
	},
	{
		group: 'delivery',
		name: 'rollback',
		description: 'move the pointer back',
		manual: 'deploying',
		args: [{ name: 'host', required: true, description: 'the hostname' }],
		options: [{ flags: '--to <id>', description: 'a version other than the previous one' }],
		surface: '/tenants'
	},

	// repair
	{
		group: 'repair',
		name: 'repair',
		description: 'run the repair for one finding',
		manual: 'repairing',
		args: [{ name: 'code', required: true, description: 'a tripwire code' }],
		options: [
			{ flags: '--rung <rung>', description: 'force a rung rather than taking the ladder s' },
			{ flags: '--auto', description: 'safe and rebuild only; never anything stateful' }
		],
		exits: [FINDING_EXIT],
		surface: '/health'
	},
	{
		group: 'repair',
		name: 'quarantine list',
		description: 'every quarantined tenant and why',
		manual: 'repairing',
		surface: '/health'
	},
	{
		group: 'repair',
		name: 'quarantine clear',
		description: 'bring a quarantined tenant back',
		manual: 'repairing',
		args: [{ name: 'tenant', required: true, description: 'the tenant name' }],
		surface: '/health'
	},
	{
		group: 'repair',
		name: 'recycle',
		description: 'restart a tenant s runtime',
		manual: 'repairing',
		args: [{ name: 'tenant', required: true, description: 'the tenant name' }],
		surface: '/health'
	},

	// backup
	{
		group: 'backup',
		name: 'backup now',
		description: 'take a backup',
		manual: 'backups',
		options: [{ flags: '--site <host>', description: 'one site rather than every site' }],
		exits: [FINDING_EXIT],
		surface: '/operations'
	},
	{
		group: 'backup',
		name: 'backup list',
		description: 'every version held',
		manual: 'backups',
		surface: '/operations'
	},
	{
		group: 'backup',
		name: 'backup show',
		description: 'one backup and its manifest',
		manual: 'backups',
		args: [{ name: 'site', required: true, description: 'the hostname' }],
		surface: '/operations'
	},
	{
		group: 'backup',
		name: 'backup verify',
		description: 'check every frame a version names',
		manual: 'backups',
		args: [{ name: 'site', required: true, description: 'the hostname' }],
		exits: [FINDING_EXIT],
		surface: '/operations'
	},
	{
		group: 'backup',
		name: 'backup prune',
		description: 'apply the retention policy',
		manual: 'backups',
		surface: '/operations'
	},
	{
		group: 'backup',
		name: 'backup restore',
		description: 'restore a version',
		manual: 'backups',
		args: [{ name: 'site', required: true, description: 'the hostname' }],
		options: [
			{ flags: '--to <tenant>', description: 'restore into another tenant' },
			{ flags: '--at <version>', description: 'a version other than the newest' }
		],
		surface: '/operations'
	},
	{
		group: 'backup',
		name: 'backup drill',
		description: 'restore into a scratch tenant and render a page from it',
		manual: 'backups',
		options: [{ flags: '--site <host>', description: 'one site rather than every site' }],
		exits: [FINDING_EXIT],
		surface: '/operations'
	},
	{
		group: 'backup',
		name: 'backup estimate',
		description: 'what the next backup would cost',
		manual: 'backups',
		args: [{ name: 'site', required: true, description: 'the hostname' }],
		surface: '/operations'
	},

	// secrets and certs
	{
		group: 'secrets',
		name: 'secrets set',
		description: 'store a secret',
		manual: 'secrets',
		args: [{ name: 'name', required: true, description: 'the secret name' }],
		options: [
			{
				flags: '--value <value>',
				description:
					'the value; prefer BASTION_SECRET_VALUE so it stays out of the shell history'
			}
		],
		exits: [JSON_EXIT],
		surface: null,
		exempt: 'a secret is typed into the CLI so the value never reaches a browser'
	},
	{
		group: 'secrets',
		name: 'secrets get',
		description: 'read a secret; audited, and never echoed under --json',
		manual: 'secrets',
		args: [{ name: 'name', required: true, description: 'the secret name' }],
		surface: null,
		exempt: 'a secret value never reaches a browser'
	},
	{
		group: 'secrets',
		name: 'secrets list',
		description: 'every secret name; never a value',
		manual: 'secrets',
		surface: '/operations'
	},
	{
		group: 'secrets',
		name: 'secrets rm',
		description: 'remove a secret',
		manual: 'secrets',
		args: [{ name: 'name', required: true, description: 'the secret name' }],
		surface: null,
		exempt: 'the secret surface is deliberately CLI only'
	},
	{
		group: 'secrets',
		name: 'secrets rotate',
		description: 'replace a secret and record the rotation',
		manual: 'secrets',
		args: [{ name: 'name', required: true, description: 'the secret name' }],
		options: [{ flags: '--value <value>', description: 'the new value' }],
		exits: [JSON_EXIT],
		surface: null,
		exempt: 'the secret surface is deliberately CLI only'
	},
	{
		group: 'secrets',
		name: 'secrets seal',
		description: 'forget the passphrase until it is given again',
		manual: 'secrets',
		surface: null,
		exempt: 'the secret surface is deliberately CLI only'
	},
	{
		group: 'secrets',
		name: 'secrets unseal',
		description: 'give the passphrase so the store answers',
		manual: 'secrets',
		exits: [FINDING_EXIT],
		surface: null,
		exempt: 'a passphrase is typed into the CLI so it never reaches a browser'
	},
	{
		group: 'certs',
		name: 'cert list',
		description: 'every certificate and when it expires',
		manual: 'tls',
		surface: '/operations'
	},
	{
		group: 'certs',
		name: 'cert issue',
		description: 'issue a certificate over ACME',
		manual: 'tls',
		args: [{ name: 'host', required: true, description: 'the hostname' }],
		options: [
			{
				flags: '--staging',
				description:
					"the CA's staging endpoint, which is not trusted and is not rate limited"
			},
			{
				flags: '--force',
				description: 'order a new certificate even where one is already installed'
			}
		],
		surface: '/operations'
	},
	{
		group: 'certs',
		name: 'cert renew',
		description: 'renew anything inside the expiry ladder',
		manual: 'tls',
		options: [
			{ flags: '--host <host>', description: 'one host rather than everything due' },
			{
				flags: '--staging',
				description:
					"the CA's staging endpoint, which is not trusted and is not rate limited"
			}
		],
		exits: [FINDING_EXIT],
		surface: '/operations'
	},
	{
		group: 'certs',
		name: 'cert import',
		description: 'install an institutional chain, after checking it',
		manual: 'tls',
		args: [
			{ name: 'host', required: true, description: 'the hostname' },
			{ name: 'chain', required: true, description: 'the PEM chain, leaf first' }
		],
		options: [
			{
				flags: '--key <path>',
				description: 'the private key; defaults to the chain path with a .key suffix'
			}
		],
		exits: [JSON_EXIT],
		surface: '/operations'
	},
	{
		group: 'certs',
		name: 'cert trust',
		description: 'install a CA certificate into this host s trust store',
		manual: 'tls',
		args: [{ name: 'cert', required: true, description: 'the CA certificate; never a key' }],
		surface: '/operations'
	},
	{
		group: 'certs',
		name: 'cert untrust',
		description: 'reverse a trust install',
		manual: 'tls',
		surface: '/operations'
	},

	// domains
	{
		group: 'domains',
		name: 'domain list',
		description: 'every domain, which tenant holds it and whether it is verified',
		manual: 'domains',
		surface: '/tenants'
	},
	{
		group: 'domains',
		name: 'domain add',
		description: 'allocate a name under the primary domain, or add a custom one',
		manual: 'domains',
		args: [
			{
				name: 'name',
				required: true,
				description: 'a label, or a full hostname for a custom root'
			}
		],
		options: [
			{ flags: '--tenant <name>', description: 'the tenant to give it to' },
			{
				flags: '--alias <host>',
				description: 'add it as an alias of an existing site rather than a new one'
			}
		],
		exits: [JSON_EXIT],
		surface: '/tenants'
	},
	{
		group: 'domains',
		name: 'domain suggest',
		description: 'a free name near the one you wanted',
		manual: 'domains',
		args: [{ name: 'preferred', required: true, description: 'the name you would like' }],
		surface: '/tenants'
	},
	{
		group: 'domains',
		name: 'domain verify',
		description: 'check ownership, DNS and CAA before a certificate is asked for',
		manual: 'domains',
		args: [{ name: 'host', required: true, description: 'the hostname' }],
		exits: [FINDING_EXIT],
		surface: '/tenants'
	},
	{
		group: 'domains',
		name: 'domain token',
		description: 'print the TXT record that proves this tenant owns a name',
		manual: 'domains',
		args: [{ name: 'host', required: true, description: 'the hostname' }],
		surface: '/tenants'
	},
	{
		group: 'certs',
		name: 'cert plan',
		description: 'which issuance path a name would take, and why',
		manual: 'tls',
		args: [{ name: 'host', required: true, description: 'the hostname' }],
		surface: '/operations'
	},
	{
		group: 'certs',
		name: 'cert self-sign',
		description: 'sign a certificate with no CA, for a lab or a local name',
		manual: 'tls',
		args: [{ name: 'host', required: true, description: 'the hostname' }],
		surface: '/operations'
	},

	// egress, updates, audit
	{
		group: 'egress',
		name: 'egress show',
		description: 'the computed policy and the live table',
		manual: 'egress',
		options: [{ flags: '--tenant <name>', description: 'one tenant only' }],
		surface: '/tenants'
	},
	{
		group: 'egress',
		name: 'egress allow',
		description: 'add a host:port to a tenant s allow list',
		manual: 'egress',
		args: [
			{ name: 'tenant', required: true, description: 'the tenant name' },
			{ name: 'target', required: true, description: 'host:port' }
		],
		surface: '/tenants'
	},
	{
		group: 'egress',
		name: 'egress deny',
		description: 'remove an entry',
		manual: 'egress',
		args: [
			{ name: 'tenant', required: true, description: 'the tenant name' },
			{ name: 'target', required: true, description: 'host:port' }
		],
		surface: '/tenants'
	},
	{
		group: 'egress',
		name: 'egress test',
		description: 'answer from the live policy whether a target is reachable',
		manual: 'egress',
		args: [
			{ name: 'tenant', required: true, description: 'the tenant name' },
			{ name: 'target', required: true, description: 'host:port' }
		],
		exits: [FINDING_EXIT],
		surface: '/tenants'
	},
	{
		group: 'updates',
		name: 'update check',
		description: 'what a newer pin would be',
		manual: 'updating',
		exits: [FINDING_EXIT],
		surface: '/operations'
	},
	{
		group: 'updates',
		name: 'update apply',
		description: 'move to a pin, verifying the binary by digest',
		manual: 'updating',
		options: [
			{ flags: '--to <version>', description: 'the version to move to' },
			{ flags: '--staged', description: 'one tenant, health-check, then the rest' },
			{
				flags: '--force-below-floor',
				description: 'accept a version below the CVE floor, naming what it accepts'
			},
			{
				flags: '--restore-from <backup>',
				description: 'required across a storage format change'
			}
		],
		exits: [JSON_EXIT],
		surface: '/operations'
	},
	{
		group: 'updates',
		name: 'update rollback',
		description: 'return to the previous pin',
		manual: 'updating',
		exits: [JSON_EXIT],
		surface: '/operations'
	},
	{
		group: 'audit',
		name: 'audit tail',
		description: 'follow the audit log',
		manual: 'auditing',
		surface: '/operations'
	},
	{
		group: 'audit',
		name: 'audit export',
		description: 'write the log for a SIEM',
		manual: 'auditing',
		options: [
			{ flags: '--syslog', description: 'RFC 5424 lines' },
			{ flags: '--ndjson', description: 'one JSON object per line' }
		],
		surface: '/operations'
	},
	{
		group: 'audit',
		name: 'audit verify',
		description: 'walk the hash chain',
		manual: 'auditing',
		options: [
			{ flags: '--cluster', description: 'compare every node s head against the registry' }
		],
		exits: [FINDING_EXIT],
		surface: '/operations'
	},
	{
		group: 'audit',
		name: 'audit profile',
		description: 'read or set the audit profile',
		manual: 'auditing',
		surface: '/operations'
	},

	// stores
	{
		group: 'stores',
		name: 'kv',
		description: 'inspect the KV adapter',
		manual: 'adapters',
		args: [{ name: 'operation', required: true, description: 'get, put, list, rm or stats' }],
		surface: '/operations'
	},
	{
		group: 'stores',
		name: 'r2',
		description: 'inspect the object adapter',
		manual: 'adapters',
		args: [{ name: 'operation', required: true, description: 'get, put, list, rm or stats' }],
		surface: '/operations'
	},
	{
		group: 'stores',
		name: 'd1',
		description: 'inspect the SQL adapter',
		manual: 'adapters',
		args: [{ name: 'operation', required: true, description: 'get, put, list, rm or stats' }],
		surface: '/operations'
	},
	{
		group: 'stores',
		name: 'queues',
		description: 'inspect the queue adapter',
		manual: 'adapters',
		args: [{ name: 'operation', required: true, description: 'get, put, list, rm or stats' }],
		surface: '/operations'
	},
	{
		group: 'stores',
		name: 'cache',
		description: 'inspect the cache adapter',
		manual: 'adapters',
		args: [{ name: 'operation', required: true, description: 'get, put, list, rm or stats' }],
		surface: '/operations'
	},

	// vm and cluster
	{
		group: 'vm',
		name: 'vm list',
		description: 'every guest; refuses by name outside isolated',
		manual: 'isolation',
		surface: '/cluster'
	},
	{
		group: 'vm',
		name: 'vm show',
		description: 'one guest',
		manual: 'isolation',
		args: [{ name: 'tenant', required: true, description: 'the tenant name' }],
		surface: '/cluster'
	},
	{
		group: 'vm',
		name: 'vm console',
		description: 'attach to a guest console',
		manual: 'isolation',
		args: [{ name: 'tenant', required: true, description: 'the tenant name' }],
		surface: null,
		exempt: 'a guest console is a terminal, not a page'
	},
	{
		group: 'vm',
		name: 'vm stop',
		description: 'stop a guest',
		manual: 'isolation',
		args: [{ name: 'tenant', required: true, description: 'the tenant name' }],
		surface: '/cluster'
	},
	{
		group: 'cluster',
		name: 'cluster init',
		description: 'make this node the control node',
		manual: 'clustering',
		surface: '/cluster'
	},
	{
		group: 'cluster',
		name: 'cluster join',
		description: 'dial out to a control node and join',
		manual: 'clustering',
		options: [
			{ flags: '--control <address>', description: 'the control node' },
			{ flags: '--token <token>', description: 'the one-time join token' }
		],
		exits: [JSON_EXIT],
		surface: '/cluster'
	},
	{
		group: 'cluster',
		name: 'cluster leave',
		description: 'leave the cluster',
		manual: 'clustering',
		surface: '/cluster'
	},
	{
		group: 'cluster',
		name: 'cluster nodes',
		description: 'every node, its state and when it was last heard from',
		manual: 'clustering',
		surface: '/cluster'
	},
	{
		group: 'cluster',
		name: 'cluster place',
		description: 'choose a primary and replicas for a site',
		manual: 'clustering',
		args: [{ name: 'site', required: true, description: 'the hostname' }],
		options: [{ flags: '--replicas <n>', description: 'how many replica nodes' }],
		surface: '/cluster'
	},
	{
		group: 'cluster',
		name: 'cluster promote',
		description: 'promote a replica, naming the worst-case write loss first',
		manual: 'clustering',
		args: [
			{ name: 'site', required: true, description: 'the hostname' },
			{ name: 'node', required: true, description: 'the node to promote' }
		],
		exits: [FINDING_EXIT],
		surface: '/cluster'
	},
	{
		group: 'cluster',
		name: 'cluster status',
		description: 'the cluster as the control node sees it',
		manual: 'clustering',
		surface: '/cluster'
	},
	{
		group: 'cluster',
		name: 'cluster provision',
		description: 'install bastion on hosts over SSH and join them',
		manual: 'clustering',
		args: [{ name: 'target', required: true, description: 'a host, a list or a CIDR' }],
		options: [
			{
				flags: '--dry-run',
				description: 'print the plan and change nothing; the default for a range'
			},
			{ flags: '--yes', description: 'act rather than printing the plan' },
			{ flags: '--only <hosts>', description: 'narrow a range' },
			{ flags: '--exclude <hosts>', description: 'skip hosts in a range' },
			{ flags: '--i-know-this-is-a-large-range', description: 'required above a /24' }
		],
		exits: [JSON_EXIT],
		surface: '/cluster'
	},

	// access, migration, api, misc
	{
		group: 'access',
		name: 'access invite',
		description: 'issue a tenant credential',
		manual: 'access',
		args: [{ name: 'tenant', required: true, description: 'the tenant name' }],
		options: [{ flags: '--role <role>', description: 'tenant-admin or tenant-viewer' }],
		surface: '/tenants'
	},
	{
		group: 'access',
		name: 'access list',
		description: 'every credential issued',
		manual: 'access',
		surface: '/tenants'
	},
	{
		group: 'access',
		name: 'access revoke',
		description: 'revoke a credential',
		manual: 'access',
		args: [{ name: 'id', required: true, description: 'the credential id' }],
		surface: '/tenants'
	},
	{
		group: 'access',
		name: 'access role',
		description: 'change a credential s role',
		manual: 'access',
		args: [
			{ name: 'id', required: true, description: 'the credential id' },
			{ name: 'role', required: true, description: 'the new role' }
		],
		surface: '/tenants'
	},
	{
		group: 'portability',
		name: 'export',
		description: 'write the portable artifact for a site',
		manual: 'migrating',
		args: [{ name: 'host', required: true, description: 'the hostname' }],
		surface: null,
		exempt: 'an artifact is written to a path the CLI names'
	},
	{
		group: 'portability',
		name: 'import',
		description: 'read a portable artifact into a site',
		manual: 'migrating',
		args: [
			{ name: 'host', required: true, description: 'the hostname' },
			{ name: 'artifact', required: true, description: 'the export to read' }
		],
		surface: null,
		exempt: 'an artifact is read from a path the CLI names'
	},
	{
		group: 'migrate',
		name: 'migrate survey',
		description: 'find every site on a source',
		manual: 'migrating',
		args: [
			{ name: 'source', required: true, description: 'an ssh target, a URL, or --cloudflare' }
		],
		surface: null,
		exempt: 'the migration wizard renders the same plan object and is its own flow'
	},
	{
		group: 'migrate',
		name: 'migrate plan',
		description: 'what would move and what will not carry',
		manual: 'migrating',
		args: [
			{ name: 'source', required: true, description: 'an ssh target, a URL, or --cloudflare' }
		],
		exits: [JSON_EXIT],
		surface: null,
		exempt: 'the migration wizard renders the same plan object and is its own flow'
	},
	{
		group: 'migrate',
		name: 'migrate run',
		description: 'execute the plan, resumable per site',
		manual: 'migrating',
		args: [
			{ name: 'source', required: true, description: 'an ssh target, a URL, or --cloudflare' }
		],
		options: [{ flags: '--yes', description: 'act; the default is a dry run' }],
		surface: null,
		exempt: 'the migration wizard renders the same plan object and is its own flow'
	},
	{
		group: 'migrate',
		name: 'migrate resume',
		description: 'continue an interrupted migration',
		manual: 'migrating',
		surface: null,
		exempt: 'the migration wizard renders the same plan object and is its own flow'
	},
	{
		group: 'migrate',
		name: 'migrate status',
		description: 'where a migration got to',
		manual: 'migrating',
		surface: null,
		exempt: 'the migration wizard renders the same plan object and is its own flow'
	},
	{
		group: 'api',
		name: 'api token create',
		description: 'issue a scoped API token',
		manual: 'access',
		options: [
			{ flags: '--tenant <name>', description: 'scope it to one tenant' },
			{ flags: '--role <role>', description: 'tenant-admin or tenant-viewer' }
		],
		surface: '/tenants'
	},
	{
		group: 'api',
		name: 'api token list',
		description: 'every token, when it was last used, and whether it is revoked',
		manual: 'access',
		surface: '/tenants'
	},
	{
		group: 'api',
		name: 'api token revoke',
		description: 'revoke a token',
		manual: 'access',
		args: [{ name: 'id', required: true, description: 'the token id' }],
		surface: '/tenants'
	},
	{
		group: 'pairing',
		name: 'pair',
		description: 'pair with the drupflare control plane',
		manual: 'pairing',
		exits: [JSON_EXIT],
		surface: null,
		exempt: 'pairing refuses in this version'
	},
	{
		group: 'pairing',
		name: 'unpair',
		description: 'stop pairing',
		manual: 'pairing',
		exits: [JSON_EXIT],
		surface: null,
		exempt: 'pairing refuses in this version'
	},
	{
		group: 'misc',
		name: 'dashboard open',
		description: 'open the dashboard in a browser',
		manual: 'dashboard',
		surface: null,
		exempt: 'the dashboard cannot open itself'
	},
	{
		group: 'misc',
		name: 'dashboard token',
		description: 'print a one-time dashboard claim token',
		manual: 'dashboard',
		surface: null,
		exempt: 'a claim token is printed once, on the terminal that has the host'
	},
	{
		group: 'misc',
		name: 'manual',
		description: 'the shipped reference, rendered in the terminal',
		manual: 'manual',
		offline: true,
		args: [{ name: 'topic', required: false, description: 'a section to render' }],
		options: [{ flags: '--list', description: 'list the topics' }],
		surface: '/manual'
	},
	{
		group: 'misc',
		name: 'completion',
		description: 'print a shell completion script',
		manual: 'getting-started',
		offline: true,
		args: [{ name: 'shell', required: true, description: 'bash, zsh or fish' }],
		surface: null,
		exempt: 'a shell completion script has no browser surface'
	},
	{
		group: 'misc',
		name: 'version',
		description: 'the version of bastion and its pinned workerd',
		manual: 'getting-started',
		offline: true,
		surface: '/'
	}
];

export const GROUPS = [...new Set(COMMANDS.map((command) => command.group))];

export function commandsIn(group: string): CommandSpec[] {
	return COMMANDS.filter((command) => command.group === group);
}

export function findCommand(name: string): CommandSpec | null {
	return COMMANDS.find((command) => command.name === name) ?? null;
}

/** the flags every command accepts, declared once rather than per command */
export const GLOBAL_OPTIONS: OptionSpec[] = [
	{ flags: '--config <file>', description: 'the bastion.yml to read' },
	{ flags: '--profile <name>', description: 'a named profile within the configuration' },
	{ flags: '--json', description: 'print the report object and nothing else on stdout' },
	{ flags: '--verbose', description: 'include a stack on an internal error' },
	{ flags: '--quiet', description: 'errors only' },
	{ flags: '--yes', description: 'do not prompt' },
	{ flags: '--no-color', description: 'plain output' }
];
