# Commands

Generated from the command definitions by `bun run docs:cli`. CI fails when it drifts, so
this file cannot disagree with the program.

## Global Flags

| flag               | meaning                                            |
| ------------------ | -------------------------------------------------- |
| `--config <file>`  | the bastion.yml to read                            |
| `--profile <name>` | a named profile within the configuration           |
| `--json`           | print the report object and nothing else on stdout |
| `--verbose`        | include a stack on an internal error               |
| `--quiet`          | errors only                                        |
| `--yes`            | do not prompt                                      |
| `--no-color`       | plain output                                       |

## Exit Codes

| code | meaning                                 |
| ---- | --------------------------------------- |
| 0    | it worked                               |
| 1    | it could not run                        |
| 2    | the input or the configuration is wrong |
| 3    | it ran and found something              |

## Lifecycle

### `bastion init`

write a bastion.yml and the state directory

| flag      | meaning                           |
| --------- | --------------------------------- |
| `--force` | overwrite an existing bastion.yml |

Documented in `bastion manual getting-started`.

### `bastion up`

start every tenant, the front door and the dashboard

| flag             | meaning                              |
| ---------------- | ------------------------------------ |
| `--no-dashboard` | do not start the management listener |
| `--mode <mode>`  | solo, hardened or isolated           |

Documented in `bastion manual running`.

### `bastion down`

stop every tenant and the front door

Documented in `bastion manual running`.

### `bastion restart`

stop and start, keeping the configuration

Documented in `bastion manual running`.

### `bastion serve`

run in the foreground; what a unit file calls

| flag            | meaning                    |
| --------------- | -------------------------- |
| `--mode <mode>` | solo, hardened or isolated |

Documented in `bastion manual running`.

## Inspect

### `bastion status`

what is running, per tenant and per site

Documented in `bastion manual running`.

### `bastion doctor`

what this host can and cannot do, and which limits are enforced

Documented in `bastion manual diagnosing`.

### `bastion health`

the health tree and every open finding

| flag     | meaning                             |
| -------- | ----------------------------------- |
| `--tree` | render as a tree rather than a list |

Documented in `bastion manual diagnosing`.

### `bastion diagnose [code]`

explain one finding and what bastion already did about it

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `code`   | no       | a tripwire code |

| flag                 | meaning                       |
| -------------------- | ----------------------------- |
| `--since <duration>` | only findings newer than this |
| `--code <code>`      | the tripwire to explain       |

Documented in `bastion manual diagnosing`.

### `bastion metrics`

the Prometheus exposition this node serves

Documented in `bastion manual observing`.

### `bastion logs`

read the structured logs

| flag                 | meaning                              |
| -------------------- | ------------------------------------ |
| `--tenant <name>`    | one tenant only                      |
| `--level <level>`    | debug, info, warn, error or critical |
| `--node <id          | all>`                                | proxy to another node, or every node |
| `--since <duration>` | only lines newer than this           |

Documented in `bastion manual observing`.

### `bastion capacity`

what this host holds, with each input s provenance

| flag              | meaning                     |
| ----------------- | --------------------------- |
| `--node <id>`     | another node in the cluster |
| `--tenant <name>` | one tenant s share          |
| `--what-if <n>`   | the answer at n sites       |

Documented in `bastion manual capacity`.

## Config

### `bastion config show`

the effective configuration, defaults merged

Documented in `bastion manual configuration`.

### `bastion config where`

every value the file set, and where it came from

Documented in `bastion manual configuration`.

### `bastion config validate`

check the file and report the path of every rejection

Documented in `bastion manual configuration`.

### `bastion config schema`

print the JSON Schema an editor completes from

Documented in `bastion manual configuration`.

## Tenants

### `bastion tenant list`

every tenant and its limits

Documented in `bastion manual tenants`.

### `bastion tenant add <name>`

create a tenant

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `name`   | yes      | the tenant name |

| flag               | meaning                  |
| ------------------ | ------------------------ |
| `--cpu <cores>`    | the cgroup cpu quota     |
| `--memory <bytes>` | the cgroup memory limit  |
| `--max-sites <n>`  | the provisioning ceiling |

Documented in `bastion manual tenants`.

### `bastion tenant show <name>`

one tenant, with its capabilities and their enforcement points

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `name`   | yes      | the tenant name |

Documented in `bastion manual tenants`.

### `bastion tenant rm <name>`

remove a tenant

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `name`   | yes      | the tenant name |

| flag      | meaning                                                               |
| --------- | --------------------------------------------------------------------- |
| `--purge` | delete its state as well; refuses without --yes and a verified backup |

Documented in `bastion manual tenants`.

### `bastion tenant limits <name>`

read or set a tenant s cgroup limits

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `name`   | yes      | the tenant name |

| flag               | meaning                  |
| ------------------ | ------------------------ |
| `--cpu <cores>`    | the cgroup cpu quota     |
| `--memory <bytes>` | the cgroup memory limit  |
| `--pids <n>`       | the process limit        |
| `--max-sites <n>`  | the provisioning ceiling |

Documented in `bastion manual tenants`.

## Sites

### `bastion site list`

every site and the tenant holding it

Documented in `bastion manual sites`.

### `bastion site add <host>`

add a site to a tenant

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

| flag              | meaning                 |
| ----------------- | ----------------------- |
| `--tenant <name>` | the tenant to add it to |
| `--bundle <path>` | the site payload        |

Documented in `bastion manual sites`.

### `bastion site rm <host>`

remove a site

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

Documented in `bastion manual sites`.

## Repair

### `bastion repair <code>`

run the repair for one finding

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `code`   | yes      | a tripwire code |

| flag            | meaning                                        |
| --------------- | ---------------------------------------------- |
| `--rung <rung>` | force a rung rather than taking the ladder s   |
| `--auto`        | safe and rebuild only; never anything stateful |

Documented in `bastion manual repairing`.

### `bastion quarantine list`

every quarantined tenant and why

Documented in `bastion manual repairing`.

### `bastion quarantine clear <tenant>`

bring a quarantined tenant back

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `tenant` | yes      | the tenant name |

Documented in `bastion manual repairing`.

## Backup

### `bastion backup now`

take a backup

| flag            | meaning                         |
| --------------- | ------------------------------- |
| `--site <host>` | one site rather than every site |

Documented in `bastion manual backups`.

### `bastion backup list`

every version held

Documented in `bastion manual backups`.

### `bastion backup verify <site>`

check every frame a version names

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `site`   | yes      | the hostname |

Documented in `bastion manual backups`.

### `bastion backup prune`

apply the retention policy

Documented in `bastion manual backups`.

### `bastion backup drill`

restore into a scratch tenant and render a page from it

| flag            | meaning                         |
| --------------- | ------------------------------- |
| `--site <host>` | one site rather than every site |

Documented in `bastion manual backups`.

## Secrets

### `bastion secrets set <name>`

store a secret

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `name`   | yes      | the secret name |

| flag              | meaning                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `--value <value>` | the value; prefer BASTION_SECRET_VALUE so it stays out of the shell history |

Documented in `bastion manual secrets`.

### `bastion secrets get <name>`

read a secret; audited, and never echoed under --json

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `name`   | yes      | the secret name |

Documented in `bastion manual secrets`.

### `bastion secrets list`

every secret name; never a value

Documented in `bastion manual secrets`.

### `bastion secrets rm <name>`

remove a secret

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `name`   | yes      | the secret name |

Documented in `bastion manual secrets`.

### `bastion secrets rotate <name>`

replace a secret and record the rotation

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `name`   | yes      | the secret name |

| flag              | meaning       |
| ----------------- | ------------- |
| `--value <value>` | the new value |

Documented in `bastion manual secrets`.

### `bastion secrets seal`

forget the passphrase until it is given again

Documented in `bastion manual secrets`.

### `bastion secrets unseal`

give the passphrase so the store answers

Documented in `bastion manual secrets`.

## Certs

### `bastion cert list`

every certificate and when it expires

Documented in `bastion manual tls`.

### `bastion cert issue <host>`

issue a certificate over ACME

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

| flag        | meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `--staging` | the CA's staging endpoint, which is not trusted and is not rate limited |
| `--force`   | order a new certificate even where one is already installed             |

Documented in `bastion manual tls`.

### `bastion cert renew`

renew anything inside the expiry ladder

| flag            | meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `--host <host>` | one host rather than everything due                                     |
| `--staging`     | the CA's staging endpoint, which is not trusted and is not rate limited |

Documented in `bastion manual tls`.

### `bastion cert import <host> <chain>`

install an institutional chain, after checking it

| argument | required | meaning                   |
| -------- | -------- | ------------------------- |
| `host`   | yes      | the hostname              |
| `chain`  | yes      | the PEM chain, leaf first |

| flag           | meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| `--key <path>` | the private key; defaults to the chain path with a .key suffix |

Documented in `bastion manual tls`.

### `bastion cert plan <host>`

which issuance path a name would take, and why

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

Documented in `bastion manual tls`.

### `bastion cert self-sign <host>`

sign a certificate with no CA, for a lab or a local name

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

Documented in `bastion manual tls`.

## Domains

### `bastion domain list`

every domain, which tenant holds it and whether it is verified

Documented in `bastion manual domains`.

### `bastion domain add <name>`

allocate a name under the primary domain, or add a custom one

| argument | required | meaning                                       |
| -------- | -------- | --------------------------------------------- |
| `name`   | yes      | a label, or a full hostname for a custom root |

| flag              | meaning                                                      |
| ----------------- | ------------------------------------------------------------ |
| `--tenant <name>` | the tenant to give it to                                     |
| `--alias <host>`  | add it as an alias of an existing site rather than a new one |

Documented in `bastion manual domains`.

### `bastion domain suggest <preferred>`

a free name near the one you wanted

| argument    | required | meaning                 |
| ----------- | -------- | ----------------------- |
| `preferred` | yes      | the name you would like |

Documented in `bastion manual domains`.

### `bastion domain verify <host>`

check ownership, DNS and CAA before a certificate is asked for

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

Documented in `bastion manual domains`.

### `bastion domain token <host>`

print the TXT record that proves this tenant owns a name

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

Documented in `bastion manual domains`.

## Egress

### `bastion egress show`

the computed policy and the live table

| flag              | meaning         |
| ----------------- | --------------- |
| `--tenant <name>` | one tenant only |

Documented in `bastion manual egress`.

### `bastion egress test <tenant> <target>`

answer from the live policy whether a target is reachable

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `tenant` | yes      | the tenant name |
| `target` | yes      | host:port       |

Documented in `bastion manual egress`.

## Updates

### `bastion update check`

what a newer pin would be

Documented in `bastion manual updating`.

### `bastion update apply`

move to a pin, verifying the binary by digest

| flag                      | meaning                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `--to <version>`          | the version to move to                                       |
| `--staged`                | one tenant, health-check, then the rest                      |
| `--force-below-floor`     | accept a version below the CVE floor, naming what it accepts |
| `--restore-from <backup>` | required across a storage format change                      |

Documented in `bastion manual updating`.

## Audit

### `bastion audit tail`

follow the audit log

Documented in `bastion manual auditing`.

### `bastion audit verify`

walk the hash chain

| flag        | meaning                                        |
| ----------- | ---------------------------------------------- |
| `--cluster` | compare every node s head against the registry |

Documented in `bastion manual auditing`.

## Vm

### `bastion vm list`

every guest; refuses by name outside isolated

Documented in `bastion manual isolation`.

## Cluster

### `bastion cluster nodes`

every node, its state and when it was last heard from

Documented in `bastion manual clustering`.

### `bastion cluster place <site>`

choose a primary and replicas for a site

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `site`   | yes      | the hostname |

| flag             | meaning                |
| ---------------- | ---------------------- |
| `--replicas <n>` | how many replica nodes |

Documented in `bastion manual clustering`.

### `bastion cluster promote <site> <node>`

promote a replica, naming the worst-case write loss first

| argument | required | meaning             |
| -------- | -------- | ------------------- |
| `site`   | yes      | the hostname        |
| `node`   | yes      | the node to promote |

Documented in `bastion manual clustering`.

### `bastion cluster provision <target>`

install bastion on hosts over SSH and join them

| argument | required | meaning                  |
| -------- | -------- | ------------------------ |
| `target` | yes      | a host, a list or a CIDR |

| flag                             | meaning                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `--dry-run`                      | print the plan and change nothing; the default for a range |
| `--yes`                          | act rather than printing the plan                          |
| `--only <hosts>`                 | narrow a range                                             |
| `--exclude <hosts>`              | skip hosts in a range                                      |
| `--i-know-this-is-a-large-range` | required above a /24                                       |

Documented in `bastion manual clustering`.

## Migrate

### `bastion migrate plan <source>`

what would move and what will not carry

| argument | required | meaning                               |
| -------- | -------- | ------------------------------------- |
| `source` | yes      | an ssh target, a URL, or --cloudflare |

Documented in `bastion manual migrating`.

## Api

### `bastion api token create`

issue a scoped API token

| flag              | meaning                       |
| ----------------- | ----------------------------- |
| `--tenant <name>` | scope it to one tenant        |
| `--role <role>`   | tenant-admin or tenant-viewer |

Documented in `bastion manual access`.

## Misc

### `bastion manual [topic]`

the shipped reference, rendered in the terminal

| argument | required | meaning             |
| -------- | -------- | ------------------- |
| `topic`  | no       | a section to render |

| flag     | meaning         |
| -------- | --------------- |
| `--list` | list the topics |

Documented in `bastion manual manual`.

### `bastion completion <shell>`

print a shell completion script

| argument | required | meaning           |
| -------- | -------- | ----------------- |
| `shell`  | yes      | bash, zsh or fish |

Documented in `bastion manual getting-started`.

### `bastion version`

the version of bastion and its pinned workerd

Documented in `bastion manual getting-started`.
