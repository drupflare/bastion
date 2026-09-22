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

| flag                                           | meaning                                                         |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `--no-dashboard`                               | do not start the management listener                            |
| `--mode <mode>`                                | solo, hardened or isolated                                      |
| `--i-understand-this-is-not-multi-tenant-safe` | accept that this mode puts no security boundary between tenants |

Documented in `bastion manual running`.

### `bastion down`

stop every tenant and the front door

Documented in `bastion manual running`.

### `bastion restart`

stop and start, keeping the configuration

| flag                                           | meaning                                                         |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `--i-understand-this-is-not-multi-tenant-safe` | accept that this mode puts no security boundary between tenants |

Documented in `bastion manual running`.

### `bastion reload`

swap the tenants whose configuration changed, leaving the rest resident

| flag      | meaning                                       |
| --------- | --------------------------------------------- |
| `--check` | report what is out of date and change nothing |

Documented in `bastion manual running`.

### `bastion serve`

run in the foreground; what a unit file calls

| flag                                           | meaning                                                         |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `--mode <mode>`                                | solo, hardened or isolated                                      |
| `--i-understand-this-is-not-multi-tenant-safe` | accept that this mode puts no security boundary between tenants |

Documented in `bastion manual running`.

## Inspect

### `bastion status`

what is running, per tenant and per site

Documented in `bastion manual running`.

### `bastion doctor`

what this host can and cannot do, and which limits are enforced

Documented in `bastion manual diagnosing`.

### `bastion capability list`

every optional binding, whether its primitive is installed, and what installs it

Documented in `bastion manual diagnosing`.

### `bastion capability install <slot>`

install the host software one optional binding needs

| argument | required | meaning           |
| -------- | -------- | ----------------- |
| `slot`   | yes      | images or browser |

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

### `bastion tail`

follow the logs as they are written

| flag              | meaning         |
| ----------------- | --------------- |
| `--tenant <name>` | one tenant only |

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

### `bastion config get <key>`

print the value of one key

| argument | required | meaning       |
| -------- | -------- | ------------- |
| `key`    | yes      | a dotted path |

Documented in `bastion manual configuration`.

### `bastion config set <key> <value>`

write one key back through the validator the UI uses

| argument | required | meaning       |
| -------- | -------- | ------------- |
| `key`    | yes      | a dotted path |
| `value`  | yes      | the new value |

Documented in `bastion manual configuration`.

### `bastion config validate`

check the file and report the path of every rejection

Documented in `bastion manual configuration`.

### `bastion config schema`

print the JSON Schema an editor completes from

Documented in `bastion manual configuration`.

### `bastion config edit`

open the file in $EDITOR and validate on save

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

### `bastion tenant suspend <name>`

stop a tenant and serve a maintenance page

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `name`   | yes      | the tenant name |

Documented in `bastion manual tenants`.

### `bastion tenant resume <name>`

bring a suspended tenant back

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `name`   | yes      | the tenant name |

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

### `bastion tenant egress <name>`

read or set a tenant s egress allow list

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `name`   | yes      | the tenant name |

Documented in `bastion manual egress`.

## Sites

### `bastion site list`

every site and the tenant holding it

Documented in `bastion manual sites`.

### `bastion site add <host>`

add a site to a tenant

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

| flag                  | meaning                                             |
| --------------------- | --------------------------------------------------- |
| `--tenant <name>`     | the tenant to add it to                             |
| `--bundle <path       | url>`                                               | the site payload                                               |
| `--template <path     | url>`                                               | pull a worker template and read its bindings from its manifest |
| `--probe <profile>`   | the profile that proves a boot                      |
| `--checksum <sha256>` | the digest a download must hash to                  |
| `--insecure-source`   | accept a plaintext download, or one on this network |

Documented in `bastion manual sites`.

### `bastion site template <source>`

read a worker template and report what bastion would and would not carry

| argument | required | meaning              |
| -------- | -------- | -------------------- |
| `source` | yes      | a url or a directory |

| flag                  | meaning                                             |
| --------------------- | --------------------------------------------------- |
| `--checksum <sha256>` | the digest a download must hash to                  |
| `--insecure-source`   | accept a plaintext download, or one on this network |

Documented in `bastion manual sites`.

### `bastion site show <host>`

one site, with its placement and its meters

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

Documented in `bastion manual sites`.

### `bastion site rm <host>`

remove a site

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

Documented in `bastion manual sites`.

### `bastion site probe <host>`

ask this box to serve the site and report what came back

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

| flag       | meaning                                                            |
| ---------- | ------------------------------------------------------------------ |
| `--public` | resolve the hostname instead, checking dns and the certificate too |

Documented in `bastion manual sites`.

## Delivery

### `bastion deploy <host> <bundle>`

upload a bundle and point the site at it

| argument | required | meaning                                |
| -------- | -------- | -------------------------------------- |
| `host`   | yes      | the hostname                           |
| `bundle` | yes      | the payload to upload, a path or a url |

| flag                  | meaning                                             |
| --------------------- | --------------------------------------------------- |
| `--checksum <sha256>` | the digest a download must hash to                  |
| `--insecure-source`   | accept a plaintext download, or one on this network |

Documented in `bastion manual deploying`.

### `bastion versions list <host>`

every version of a site

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

Documented in `bastion manual deploying`.

### `bastion versions show <host> <id>`

one version

| argument | required | meaning        |
| -------- | -------- | -------------- |
| `host`   | yes      | the hostname   |
| `id`     | yes      | the version id |

Documented in `bastion manual deploying`.

### `bastion versions diff <host> <from> <to>`

what changed between two versions

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |
| `from`   | yes      | a version id |
| `to`     | yes      | a version id |

Documented in `bastion manual deploying`.

### `bastion versions pin <host> <id>`

hold a version so retention cannot remove it

| argument | required | meaning        |
| -------- | -------- | -------------- |
| `host`   | yes      | the hostname   |
| `id`     | yes      | the version id |

Documented in `bastion manual deploying`.

### `bastion rollout <host>`

send a share of traffic to a version

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

| flag            | meaning                        |
| --------------- | ------------------------------ |
| `--to <id>`     | the version to send traffic to |
| `--percent <n>` | the share, 0 to 100            |

Documented in `bastion manual deploying`.

### `bastion rollback <host>`

move the pointer back

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

| flag        | meaning                               |
| ----------- | ------------------------------------- |
| `--to <id>` | a version other than the previous one |

Documented in `bastion manual deploying`.

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

### `bastion recycle <tenant>`

restart a tenant s runtime

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

### `bastion backup show <site>`

one backup and its manifest

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `site`   | yes      | the hostname |

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

### `bastion backup restore <site>`

restore a version

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `site`   | yes      | the hostname |

| flag             | meaning                         |
| ---------------- | ------------------------------- |
| `--to <tenant>`  | restore into another tenant     |
| `--at <version>` | a version other than the newest |

Documented in `bastion manual backups`.

### `bastion backup drill`

restore into a scratch tenant and render a page from it

| flag            | meaning                         |
| --------------- | ------------------------------- |
| `--site <host>` | one site rather than every site |

Documented in `bastion manual backups`.

### `bastion backup estimate <site>`

what the next backup would cost

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `site`   | yes      | the hostname |

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

### `bastion cert trust <cert>`

install a CA certificate into this host s trust store

| argument | required | meaning                         |
| -------- | -------- | ------------------------------- |
| `cert`   | yes      | the CA certificate; never a key |

Documented in `bastion manual tls`.

### `bastion cert untrust`

reverse a trust install

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

### `bastion egress allow <tenant> <target>`

add a host:port to a tenant s allow list

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `tenant` | yes      | the tenant name |
| `target` | yes      | host:port       |

Documented in `bastion manual egress`.

### `bastion egress deny <tenant> <target>`

remove an entry

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `tenant` | yes      | the tenant name |
| `target` | yes      | host:port       |

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

### `bastion update rollback`

return to the previous pin

Documented in `bastion manual updating`.

## Audit

### `bastion audit tail`

follow the audit log

Documented in `bastion manual auditing`.

### `bastion audit export`

write the log for a SIEM

| flag       | meaning                  |
| ---------- | ------------------------ |
| `--syslog` | RFC 5424 lines           |
| `--ndjson` | one JSON object per line |

Documented in `bastion manual auditing`.

### `bastion audit verify`

walk the hash chain

| flag        | meaning                                        |
| ----------- | ---------------------------------------------- |
| `--cluster` | compare every node s head against the registry |

Documented in `bastion manual auditing`.

### `bastion audit profile`

read or set the audit profile

Documented in `bastion manual auditing`.

## Stores

### `bastion kv <operation>`

inspect the KV adapter

| argument    | required | meaning                     |
| ----------- | -------- | --------------------------- |
| `operation` | yes      | get, put, list, rm or stats |

Documented in `bastion manual adapters`.

### `bastion r2 <operation>`

inspect the object adapter

| argument    | required | meaning                     |
| ----------- | -------- | --------------------------- |
| `operation` | yes      | get, put, list, rm or stats |

Documented in `bastion manual adapters`.

### `bastion d1 <operation>`

inspect the SQL adapter

| argument    | required | meaning                     |
| ----------- | -------- | --------------------------- |
| `operation` | yes      | get, put, list, rm or stats |

Documented in `bastion manual adapters`.

### `bastion queues <operation>`

inspect the queue adapter

| argument    | required | meaning                     |
| ----------- | -------- | --------------------------- |
| `operation` | yes      | get, put, list, rm or stats |

Documented in `bastion manual adapters`.

### `bastion cache <operation>`

inspect the cache adapter

| argument    | required | meaning                     |
| ----------- | -------- | --------------------------- |
| `operation` | yes      | get, put, list, rm or stats |

Documented in `bastion manual adapters`.

## Vm

### `bastion vm list`

every guest; refuses by name outside isolated

Documented in `bastion manual isolation`.

### `bastion vm show <tenant>`

one guest

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `tenant` | yes      | the tenant name |

Documented in `bastion manual isolation`.

### `bastion vm console <tenant>`

attach to a guest console

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `tenant` | yes      | the tenant name |

Documented in `bastion manual isolation`.

### `bastion vm stop <tenant>`

stop a guest

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `tenant` | yes      | the tenant name |

Documented in `bastion manual isolation`.

## Cluster

### `bastion cluster init`

make this node the control node and mint a join token

| flag          | meaning                                           |
| ------------- | ------------------------------------------------- |
| `--node <id>` | the id this node answers to                       |
| `--rotate`    | mint a fresh join token on a node already control |

Documented in `bastion manual clustering`.

### `bastion cluster join`

dial out to a control node and join

| flag                  | meaning                     |
| --------------------- | --------------------------- |
| `--control <address>` | the control node            |
| `--token <token>`     | the one-time join token     |
| `--node <id>`         | the id this node answers to |

Documented in `bastion manual clustering`.

### `bastion cluster leave`

leave the cluster

Documented in `bastion manual clustering`.

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

### `bastion cluster status`

the cluster as the control node sees it

Documented in `bastion manual clustering`.

### `bastion cluster provision <target>`

install bastion on hosts over SSH and join them

| argument | required | meaning                  |
| -------- | -------- | ------------------------ |
| `target` | yes      | a host, a list or a CIDR |

| flag                             | meaning                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `--dry-run`                      | print the plan and change nothing; the default for a range |
| `--only <hosts>`                 | narrow a range                                             |
| `--exclude <hosts>`              | skip hosts in a range                                      |
| `--i-know-this-is-a-large-range` | required above a /24                                       |

Documented in `bastion manual clustering`.

## Access

### `bastion access invite <tenant>`

issue a tenant credential

| argument | required | meaning         |
| -------- | -------- | --------------- |
| `tenant` | yes      | the tenant name |

| flag            | meaning                       |
| --------------- | ----------------------------- |
| `--role <role>` | tenant-admin or tenant-viewer |

Documented in `bastion manual access`.

### `bastion access list`

every credential issued

Documented in `bastion manual access`.

### `bastion access revoke <id>`

revoke a credential

| argument | required | meaning           |
| -------- | -------- | ----------------- |
| `id`     | yes      | the credential id |

Documented in `bastion manual access`.

### `bastion access role <id> <role>`

change a credential s role

| argument | required | meaning           |
| -------- | -------- | ----------------- |
| `id`     | yes      | the credential id |
| `role`   | yes      | the new role      |

Documented in `bastion manual access`.

## Portability

### `bastion export <host>`

write the portable artifact for a site

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `host`   | yes      | the hostname |

Documented in `bastion manual migrating`.

### `bastion import <host> <artifact>`

read a portable artifact into a site

| argument   | required | meaning            |
| ---------- | -------- | ------------------ |
| `host`     | yes      | the hostname       |
| `artifact` | yes      | the export to read |

Documented in `bastion manual migrating`.

## Migrate

### `bastion migrate survey <source>`

find every site on a source

| argument | required | meaning                               |
| -------- | -------- | ------------------------------------- |
| `source` | yes      | an ssh target, a URL, or --cloudflare |

Documented in `bastion manual migrating`.

### `bastion migrate plan <source>`

what would move and what will not carry

| argument | required | meaning                               |
| -------- | -------- | ------------------------------------- |
| `source` | yes      | an ssh target, a URL, or --cloudflare |

Documented in `bastion manual migrating`.

### `bastion migrate run <source>`

execute the plan, resumable per site

| argument | required | meaning                               |
| -------- | -------- | ------------------------------------- |
| `source` | yes      | an ssh target, a URL, or --cloudflare |

Documented in `bastion manual migrating`.

### `bastion migrate resume`

continue an interrupted migration

Documented in `bastion manual migrating`.

### `bastion migrate status`

where a migration got to

Documented in `bastion manual migrating`.

## Api

### `bastion api token create [name]`

issue a scoped API token

| argument | required | meaning               |
| -------- | -------- | --------------------- |
| `name`   | no       | a label for the token |

| flag              | meaning                       |
| ----------------- | ----------------------------- |
| `--tenant <name>` | scope it to one tenant        |
| `--role <role>`   | tenant-admin or tenant-viewer |

Documented in `bastion manual access`.

### `bastion api token list`

every token, when it was last used, and whether it is revoked

Documented in `bastion manual access`.

### `bastion api token revoke <id>`

revoke a token

| argument | required | meaning      |
| -------- | -------- | ------------ |
| `id`     | yes      | the token id |

Documented in `bastion manual access`.

## Pairing

### `bastion pair`

pair with the drupflare control plane

Documented in `bastion manual pairing`.

### `bastion unpair`

stop pairing

Documented in `bastion manual pairing`.

## Misc

### `bastion dashboard open`

open the dashboard in a browser

Documented in `bastion manual dashboard`.

### `bastion dashboard token`

print a one-time dashboard claim token

Documented in `bastion manual dashboard`.

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
