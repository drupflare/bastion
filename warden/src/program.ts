import type { Context } from '@drupflare/bastion';
import { Command, Option } from 'commander';
import {
	runAccessInvite,
	runAccessList,
	runAccessRevoke,
	runAccessRole,
	runAuditExport,
	runAuditProfile,
	runTokenList,
	runTokenRevoke
} from './commands/access';
import {
	runClusterInit,
	runClusterJoin,
	runClusterLeave,
	runClusterNodes,
	runClusterPlace,
	runClusterPromote,
	runClusterProvision,
	runClusterStatus,
	runMigratePlan,
	runMigrateResume,
	runMigrateRun,
	runMigrateStatus,
	runMigrateSurvey
} from './commands/cluster';
import {
	runConfigEdit,
	runConfigGet,
	runConfigSchema,
	runConfigSet,
	runConfigShow,
	runConfigValidate,
	runConfigWhere
} from './commands/config';
import {
	runRollout as runDeliveryRollout,
	runDeploy,
	runExport,
	runImport,
	runRollback,
	runVersionDiff,
	runVersionList,
	runVersionPin,
	runVersionShow
} from './commands/delivery';
import { runDoctor } from './commands/doctor';
import {
	runCertImport,
	runCertIssue,
	runCertPlan,
	runCertSelfSign,
	runDomainAdd,
	runDomainList,
	runDomainSuggest,
	runDomainToken,
	runDomainVerify
} from './commands/domains';
import {
	runCapabilityInstall,
	runCapabilityList,
	runCapacity,
	runDiagnose,
	runHealth,
	runLogs,
	runMetrics,
	runStatus,
	runVersion
} from './commands/inspect';
import {
	runCompletion,
	runDown,
	runInit,
	runManual,
	runRestart,
	runServe,
	runUp
} from './commands/lifecycle';
import {
	runBackupDrill,
	runBackupNow,
	runCertRenew,
	runQuarantineClear,
	runSecretsRm,
	runSecretsRotate,
	runSecretsSeal,
	runSecretsSet,
	runSecretsUnseal,
	runTenantLimits,
	runUpdateApply
} from './commands/maintain';
import {
	runEgressAllow,
	runEgressDeny,
	runSiteProbe,
	runSiteShow,
	runTenantEgress,
	runTenantResume,
	runTenantSuspend,
	runVmConsole,
	runVmShow,
	runVmStop
} from './commands/manage';
import {
	runBackupEstimate,
	runBackupRestore,
	runBackupShow,
	runCertTrust,
	runCertUntrust,
	runDashboardOpen,
	runDashboardToken,
	runPair,
	runRecycle,
	runReload,
	runTail,
	runUnpair,
	runUpdateRollback
} from './commands/operate';
import {
	runAuditTail,
	runAuditVerify,
	runCertList,
	runEgressShow,
	runEgressTest,
	runSecretsGet,
	runSecretsList,
	runUpdateCheck
} from './commands/ops';
import { STORES, runStore, type Store } from './commands/stores';
import {
	runBackupList,
	runBackupPrune,
	runBackupVerify,
	runQuarantineList,
	runRepair,
	runSiteAdd,
	runSiteList,
	runSiteRm,
	runSiteTemplate,
	runTenantAdd,
	runTenantList,
	runTenantRm,
	runTenantShow,
	runTokenCreate,
	runVmList
} from './commands/tenants';
import { COMMANDS, GLOBAL_OPTIONS, type CommandSpec } from './registry';
import type { Globals } from './state';
import { VERSION } from './version';

const DESCRIPTION =
	'A hardened operating environment for self-hosted workerd. Read-only apart from the ' +
	'commands that say what they write.';

type Handler = (
	ctx: Context,
	globals: Globals,
	args: (string | undefined)[]
) => void | Promise<void | number> | number;

/**
 * Every command that has an implementation.
 *
 * The map is the truth rather than a flag on the spec: a command is registered when there is
 * something to run, so nothing appears in `--help` that answers an error. A spec asserts both
 * directions, so a handler added without a table entry fails too.
 */
export const HANDLERS: Record<string, Handler> = {
	init: (ctx, globals) => runInit(ctx, globals),
	serve: (ctx, globals) => runServe(ctx, globals),
	up: (ctx, globals) => runUp(ctx, globals),
	down: (ctx, globals) => runDown(ctx, globals),
	restart: (ctx, globals) => runRestart(ctx, globals),
	status: (ctx, globals) => runStatus(ctx, globals),
	doctor: (ctx, globals) => runDoctor(ctx, globals),
	health: (ctx, globals) => runHealth(ctx, globals),
	diagnose: (ctx, globals, args) =>
		runDiagnose(ctx, { ...globals, ...(args[0] === undefined ? {} : { code: args[0] }) }),
	metrics: (ctx, globals) => runMetrics(ctx, globals),
	logs: (ctx, globals) => runLogs(ctx, globals),
	capacity: (ctx, globals) => runCapacity(ctx, globals),
	'capability list': (ctx, globals) => runCapabilityList(ctx, globals),
	'capability install': (ctx, globals, args) =>
		runCapabilityInstall(ctx, globals, args[0] as string),
	version: (ctx, globals) => runVersion(ctx, globals),

	'config show': (ctx, globals) => runConfigShow(ctx, globals),
	'config where': (ctx, globals) => runConfigWhere(ctx, globals),
	'config validate': (ctx, globals) => runConfigValidate(ctx, globals),
	'config schema': (ctx) => runConfigSchema(ctx),

	'tenant list': (ctx, globals) => runTenantList(ctx, globals),
	'tenant add': (ctx, globals, args) => runTenantAdd(ctx, globals, args[0] as string),
	'tenant show': (ctx, globals, args) => runTenantShow(ctx, globals, args[0] as string),
	'tenant rm': (ctx, globals, args) => runTenantRm(ctx, globals, args[0] as string),
	'site list': (ctx, globals) => runSiteList(ctx, globals),
	'site add': (ctx, globals, args) => runSiteAdd(ctx, globals, args[0] as string),
	'site template': (ctx, globals, args) => runSiteTemplate(ctx, globals, args[0] as string),
	'site rm': (ctx, globals, args) => runSiteRm(ctx, globals, args[0] as string),

	repair: (ctx, globals, args) => runRepair(ctx, globals, args[0] as string),
	'quarantine list': (ctx, globals) => runQuarantineList(ctx, globals),
	'quarantine clear': (ctx, globals, args) => runQuarantineClear(ctx, globals, args[0] as string),
	'tenant limits': (ctx, globals, args) => runTenantLimits(ctx, globals, args[0] as string),
	'secrets set': (ctx, globals, args) => runSecretsSet(ctx, globals, args[0] as string),
	'secrets rm': (ctx, globals, args) => runSecretsRm(ctx, globals, args[0] as string),
	'secrets rotate': (ctx, globals, args) => runSecretsRotate(ctx, globals, args[0] as string),
	'secrets seal': (ctx, globals) => runSecretsSeal(ctx, globals),
	'secrets unseal': (ctx, globals) => runSecretsUnseal(ctx, globals),
	'backup now': (ctx, globals) => runBackupNow(ctx, globals),
	'backup drill': (ctx, globals) => runBackupDrill(ctx, globals),
	'update apply': (ctx, globals) => runUpdateApply(ctx, globals),
	'cert renew': (ctx, globals) => runCertRenew(ctx, globals),
	'vm list': (ctx, globals) => runVmList(ctx, globals),

	'backup list': (ctx, globals) => runBackupList(ctx, globals),
	'backup verify': (ctx, globals, args) => runBackupVerify(ctx, globals, args[0] as string),
	'backup prune': (ctx, globals) => runBackupPrune(ctx, globals),

	'secrets list': (ctx, globals) => runSecretsList(ctx, globals),
	'secrets get': (ctx, globals, args) => runSecretsGet(ctx, globals, args[0] as string),
	'cert list': (ctx, globals) => runCertList(ctx, globals),
	'cert plan': (ctx, globals, args) => runCertPlan(ctx, globals, args[0] as string),
	'cert issue': (ctx, globals, args) => runCertIssue(ctx, globals, args[0] as string),
	'cert import': (ctx, globals, args) =>
		runCertImport(ctx, globals, args[0] as string, args[1] as string),
	'cert self-sign': (ctx, globals, args) => runCertSelfSign(ctx, globals, args[0] as string),
	'domain list': (ctx, globals) => runDomainList(ctx, globals),
	'domain add': (ctx, globals, args) => runDomainAdd(ctx, globals, args[0] as string),
	'domain suggest': (ctx, globals, args) => runDomainSuggest(ctx, globals, args[0] as string),
	'domain verify': (ctx, globals, args) => runDomainVerify(ctx, globals, args[0] as string),
	'domain token': (ctx, globals, args) => runDomainToken(ctx, globals, args[0] as string),
	'egress show': (ctx, globals) => runEgressShow(ctx, globals),
	'egress test': (ctx, globals, args) =>
		runEgressTest(ctx, globals, args[0] as string, args[1] as string),
	'update check': (ctx, globals) => runUpdateCheck(ctx, globals),
	'audit tail': (ctx, globals) => runAuditTail(ctx, globals),
	'audit verify': (ctx, globals) => runAuditVerify(ctx, globals),

	'cluster nodes': (ctx, globals) => runClusterNodes(ctx, globals),
	'cluster place': (ctx, globals, args) => runClusterPlace(ctx, globals, args[0] as string),
	'cluster promote': (ctx, globals, args) =>
		runClusterPromote(ctx, globals, args[0] as string, args[1] as string),
	'cluster provision': (ctx, globals, args) =>
		runClusterProvision(ctx, globals, args[0] as string),
	'migrate plan': (ctx, globals, args) => runMigratePlan(ctx, globals, args[0] as string),

	'api token create': (ctx, globals, args) => runTokenCreate(ctx, globals, args[0]),
	manual: (ctx, globals, args) => runManual(ctx, globals, args[0]),
	completion: (ctx, globals, args) => runCompletion(ctx, globals, args[0] as string),

	reload: (ctx, globals) => runReload(ctx, globals),
	tail: (ctx, globals) => runTail(ctx, globals),
	recycle: (ctx, globals, args) => runRecycle(ctx, globals, args[0] as string),

	'config get': (ctx, globals, args) => runConfigGet(ctx, globals, args[0] as string),
	'config set': (ctx, globals, args) =>
		runConfigSet(ctx, globals, args[0] as string, args[1] as string),
	'config edit': (ctx, globals) => runConfigEdit(ctx, globals),

	'tenant suspend': (ctx, globals, args) => runTenantSuspend(ctx, globals, args[0] as string),
	'tenant resume': (ctx, globals, args) => runTenantResume(ctx, globals, args[0] as string),
	'tenant egress': (ctx, globals, args) => runTenantEgress(ctx, globals, args[0] as string),
	'site show': (ctx, globals, args) => runSiteShow(ctx, globals, args[0] as string),
	'site probe': (ctx, globals, args) => runSiteProbe(ctx, globals, args[0] as string),

	deploy: (ctx, globals, args) => runDeploy(ctx, globals, args[0] as string, args[1] as string),
	'versions list': (ctx, globals, args) => runVersionList(ctx, globals, args[0] as string),
	'versions show': (ctx, globals, args) =>
		runVersionShow(ctx, globals, args[0] as string, args[1] as string),
	'versions diff': (ctx, globals, args) =>
		runVersionDiff(ctx, globals, args[0] as string, args[1] as string, args[2] as string),
	'versions pin': (ctx, globals, args) =>
		runVersionPin(ctx, globals, args[0] as string, args[1] as string),
	rollout: (ctx, globals, args) => runDeliveryRollout(ctx, globals, args[0] as string),
	rollback: (ctx, globals, args) => runRollback(ctx, globals, args[0] as string),
	export: (ctx, globals, args) => runExport(ctx, globals, args[0] as string),
	import: (ctx, globals, args) => runImport(ctx, globals, args[0] as string, args[1] as string),

	'backup show': (ctx, globals, args) => runBackupShow(ctx, globals, args[0] as string),
	'backup restore': (ctx, globals, args) => runBackupRestore(ctx, globals, args[0] as string),
	'backup estimate': (ctx, globals, args) => runBackupEstimate(ctx, globals, args[0] as string),

	'cert trust': (ctx, globals, args) => runCertTrust(ctx, globals, args[0] as string),
	'cert untrust': (ctx, globals) => runCertUntrust(ctx, globals),

	'egress allow': (ctx, globals, args) =>
		runEgressAllow(ctx, globals, args[0] as string, args[1] as string),
	'egress deny': (ctx, globals, args) =>
		runEgressDeny(ctx, globals, args[0] as string, args[1] as string),

	'update rollback': (ctx, globals) => runUpdateRollback(ctx, globals),
	'audit export': (ctx, globals) => runAuditExport(ctx, globals),
	'audit profile': (ctx, globals) => runAuditProfile(ctx, globals),

	'vm show': (ctx, globals, args) => runVmShow(ctx, globals, args[0] as string),
	'vm console': (ctx, globals, args) => runVmConsole(ctx, globals, args[0] as string),
	'vm stop': (ctx, globals, args) => runVmStop(ctx, globals, args[0] as string),

	'cluster init': (ctx, globals) => runClusterInit(ctx, globals),
	'cluster join': (ctx, globals) => runClusterJoin(ctx, globals),
	'cluster leave': (ctx, globals) => runClusterLeave(ctx, globals),
	'cluster status': (ctx, globals) => runClusterStatus(ctx, globals),

	'access invite': (ctx, globals, args) => runAccessInvite(ctx, globals, args[0] as string),
	'access list': (ctx, globals) => runAccessList(ctx, globals),
	'access revoke': (ctx, globals, args) => runAccessRevoke(ctx, globals, args[0] as string),
	'access role': (ctx, globals, args) =>
		runAccessRole(ctx, globals, args[0] as string, args[1] as string),

	'migrate survey': (ctx, globals, args) => runMigrateSurvey(ctx, globals, args[0] as string),
	'migrate run': (ctx, globals, args) => runMigrateRun(ctx, globals, args[0] as string),
	'migrate resume': (ctx, globals) => runMigrateResume(ctx, globals),
	'migrate status': (ctx, globals) => runMigrateStatus(ctx, globals),

	'api token list': (ctx, globals) => runTokenList(ctx, globals),
	'api token revoke': (ctx, globals, args) => runTokenRevoke(ctx, globals, args[0] as string),

	pair: (ctx, globals) => runPair(ctx, globals),
	unpair: (ctx, globals) => runUnpair(ctx, globals),
	'dashboard open': (ctx, globals) => runDashboardOpen(ctx, globals),
	'dashboard token': (ctx, globals) => runDashboardToken(ctx, globals),

	// the five store inspectors share one handler; the adapter is the command name
	...Object.fromEntries(
		STORES.map((store) => [
			store,
			(ctx: Context, globals: Globals, args: (string | undefined)[]) =>
				runStore(ctx, globals, store as Store, args[0] as string)
		])
	)
};

export const IMPLEMENTED: CommandSpec[] = COMMANDS.filter(
	(command) => HANDLERS[command.name] !== undefined
);

function camel(flag: string): string {
	const name = (flag.split(/[ ,]/).find((part) => part.startsWith('--')) ?? '').replace(
		/^--/,
		''
	);
	return name.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
}

/** carries a finding exit code out of a commander action, which has no way to return one */
export interface Outcome {
	code: number;
}

export function buildProgram(ctx: Context, outcome: Outcome = { code: 0 }): Command {
	const program = new Command();
	program
		.name('bastion')
		.description(DESCRIPTION)
		.version(VERSION, '-V, --version')
		.showHelpAfterError()
		.exitOverride((error) => {
			if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')
				return;
			throw error;
		});

	for (const option of GLOBAL_OPTIONS) {
		program.addOption(new Option(option.flags, option.description));
	}

	/** merges the program's options with the subcommand's, so either order on the line works */
	const globals = (command?: Command): Globals => {
		const root = program.opts<Record<string, unknown>>();
		const local = (command?.opts<Record<string, unknown>>() ?? {}) as Record<string, unknown>;
		const merged: Record<string, unknown> = { ...root };
		for (const [key, value] of Object.entries(local)) {
			if (value !== undefined && value !== false) merged[key] = value;
		}
		return merged as Globals;
	};

	// groups nest to whatever depth the table uses: `api token create` needs `api` and
	// `api token` to exist as intermediate commands before the leaf can hang off one
	const groups = new Map<string, Command>();
	const groupFor = (path: string[]): Command => {
		let parent = program;
		for (let depth = 0; depth < path.length - 1; depth++) {
			const key = path.slice(0, depth + 1).join(' ');
			const existing = groups.get(key);
			if (existing !== undefined) {
				parent = existing;
				continue;
			}
			const created = parent
				.command(path[depth] as string)
				.description(`${path[depth]} commands`);
			groups.set(key, created);
			parent = created;
		}
		return parent;
	};

	for (const spec of IMPLEMENTED) {
		const path = spec.name.split(' ');
		const parent = groupFor(path);
		const leaf = path[path.length - 1] as string;
		const args = (spec.args ?? [])
			.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`))
			.join(' ');
		const command = parent
			.command(`${leaf}${args === '' ? '' : ` ${args}`}`)
			.description(spec.description);

		const declared = new Set<string>();
		for (const option of spec.options ?? []) {
			command.addOption(new Option(option.flags, option.description));
			declared.add(camel(option.flags));
		}
		// every subcommand accepts the global flags itself as well as inheriting them, so
		// `bastion doctor --json` and `bastion --json doctor` both parse. A command that already
		// declares one of them keeps its own; adding it twice is what commander refuses
		for (const option of GLOBAL_OPTIONS) {
			if (declared.has(camel(option.flags))) continue;
			command.addOption(new Option(option.flags, option.description).hideHelp());
		}

		command.action(async function (this: Command, ...raw: unknown[]) {
			// an absent optional argument stays undefined rather than becoming '': `bastion manual`
			// with no topic has to reach the handler as "no topic", not as the topic named ''
			const positional = raw
				.slice(0, (spec.args ?? []).length)
				.map((value) =>
					value === undefined || value === null ? undefined : String(value)
				);
			const merged = globals(this);
			for (const option of spec.options ?? []) {
				const key = camel(option.flags);
				const value = this.opts<Record<string, unknown>>()[key];
				if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
			}
			const handler = HANDLERS[spec.name] as Handler;
			const code = await handler(ctx, merged, positional);
			if (typeof code === 'number' && code !== 0) outcome.code = code;
		});
	}

	return program;
}
