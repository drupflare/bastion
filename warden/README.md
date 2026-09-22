# bastion

> 🏰 A hardened operating environment for self-hosted workerd

`workerd` is Cloudflare's JavaScript and Wasm runtime, and its own repository is direct about what
it is not:

> When using `workerd` to run possibly-malicious code, you must run it inside an appropriate secure
> sandbox, such as a virtual machine.

Cloudflare Workers is workerd plus a hardened operating environment. bastion is that environment,
as one binary you run on your own hardware.

`warden` is the package; the binary it installs is `bastion`, and `warden` is an alias for it.

## Table of Contents

- [Why bastion](#why-bastion)
- [Install](#install)
- [Getting Started](#getting-started)
- [Isolation Modes](#isolation-modes)
- [What workerd Does Not Supply](#what-workerd-does-not-supply)
- [Configuration](#configuration)
- [Tenants and Sites](#tenants-and-sites)
- [Capabilities](#capabilities)
- [The Front Door](#the-front-door)
- [Clustering](#clustering)
- [Backups](#backups)
- [Updates](#updates)
- [Commands](#commands)
- [Limits](#limits)
- [License](#license)

## Why bastion

Running `workerd serve` yourself gets you a runtime. It does not get you process supervision,
resource limits, egress control, TLS, secrets, backups, an audit log, or a tenant boundary. Every
one of those is a question an institutional security review asks, and "configure it yourself" is
not an answer that passes.

bastion supplies them, states which isolation modes are safe for mutually untrusted tenants, and
refuses to describe the others that way.

## Install

```sh
bun add -g @drupflare/warden
# or: npm install -g @drupflare/warden
```

Both `bastion` and `warden` are on your `PATH` afterwards. Prebuilt binaries for Linux and macOS
are attached to each release.

## Getting Started

```sh
bastion init   # write bastion.yml and the state directory
bastion doctor # what this host can and cannot do
bastion up     # pin workerd, start the supervisor, serve
```

`doctor` runs before anything else is worth trying. It prints the limits bastion can enforce on
this machine, the ones it can only declare, the clock's sync source, and the pinned runtime's
resolved V8 version against the security floor.

## Isolation Modes

| Mode       | Boundary around each tenant                    | Multi-tenant safe |
| ---------- | ---------------------------------------------- | ----------------- |
| `solo`     | the host; cgroups v2 for CPU, memory and pids  | no                |
| `hardened` | plus a network namespace, seccomp and AppArmor | no                |
| `isolated` | plus one microVM per tenant                    | yes               |

Every mode runs one workerd process per tenant. The mode chooses how strong the wall around that
process is.

**`solo` and `hardened` are not safe for mutually untrusted tenants.** A Durable Object is a v8
isolate, and an isolate boundary is a correctness boundary rather than a security one. Cloudflare
has published a working Spectre read against co-located Workers in production; on one box you do
not have to win co-location, you have it by construction. Running either mode with more than one
tenant configured requires an explicit acknowledgement flag, and bastion prints the warning first.

## What workerd Does Not Supply

Durable Objects, DO SQLite, on-disk storage and alarms are native. These are not, and bastion
provides each one:

| Binding          | workerd                        | bastion                                                |
| ---------------- | ------------------------------ | ------------------------------------------------------ |
| Cache API        | mandatory, with no store       | a disk-backed cache with a memory tier                 |
| KV               | a service designator, no store | SQLite, Redis, Valkey or memory                        |
| R2               | a service designator, no store | filesystem, S3, R2, Azure, GCS, B2, SFTP or FTP        |
| Queues           | a service designator, no store | SQLite                                                 |
| D1               | no field at all                | SQLite, PostgreSQL, MySQL or MariaDB                   |
| Static assets    | no field at all                | a worker that applies an ignore list and content types |
| Cron triggers    | no field at all                | the bastion scheduler                                  |
| Version metadata | no field at all                | content-addressed versions and deployments             |

Serving static assets straight from a directory is not one of the options. A bare disk service
answers every request `application/octet-stream`, ignores the ignore list, and will hand out a site
database to anyone who asks for it by name.

## Configuration

One file, `bastion.yml`, with a published JSON Schema so an editor completes it:

```yaml
# yaml-language-server: $schema=https://bastion.drupflare.dev/schema.json
version: 1
mode: solo
state: /var/lib/bastion
tenants:
  - name: acme
    sites:
      - host: www.example.edu
        bundle: ./payload.tar.gz
    limits: { cpu: '2', memory: 4Gi, maxSites: 40 }
    egress: { allow: ['smtp.example.edu:587'] }
```

`bastion config validate` reports the path of every rejection. `bastion config where` prints each
resolved value and the file, flag or default that supplied it.

Secrets never go in this file. They live in the OS keyring, an environment variable, an encrypted
file, or a KMS.

## Tenants and Sites

A **tenant** is the isolation unit and the security principal: one organisation, holding one or
more sites. A **site** is one hostname, and one Durable Object.

Drawing the tenant boundary is how you decide who administers what. A university might give each
department its own tenant and hand the department's IT liaison a `tenant-admin` credential, while
a school district keeps one tenant and gives teachers only their site's owner token, so they work
in the CMS and never see a box.

| Role            | Reaches                                                                        |
| --------------- | ------------------------------------------------------------------------------ |
| `operator`      | the host, the cluster, every tenant                                            |
| `tenant-admin`  | one tenant: create sites within quota, deploy, roll back, read health and logs |
| `tenant-viewer` | one tenant, read only                                                          |

Site content stays with the CMS. bastion does not model editorial permissions, and
[`drangler`](https://github.com/drupflare/drangler) works against a bastion-hosted site exactly as
it does against a Cloudflare-hosted one.

## Capabilities

Turn features off per tenant. Each one names how it is enforced:

```yaml
capabilities:
  codegen: false # the binding is absent from the runtime config
  workerLoader: false # the binding is absent
  diagnosticRoutes: false # blocked at the front door, per route
  extensions: [curl, openssl] # an operator-curated catalogue
```

A capability marked enforced is unreachable, not discouraged. Where bastion can only set a variable
the site could override, it says so rather than implying containment it does not have.

## The Front Door

workerd terminates one certificate per socket and cannot do SNI, so bastion terminates TLS itself
and workerd listens on a unix socket behind it. That front door also carries the things workerd has
no equivalent for: per-IP and per-tenant rate limits, a request body cap, slowloris timeouts,
connection limits, `Accept-Encoding` negotiation and HTTP/2.

It also rewrites `CF-Connecting-IP` on every inbound request from the real peer address. On
Cloudflare that header is overwritten at the edge, which is what makes it trustworthy; on a bare
host nothing overwrites it, so a client could otherwise set it and defeat per-IP flood control.

ACME with automatic renewal is built in, and an institution's own CA is a supported alternative.

## Clustering

A Durable Object lives in one runtime instance, so bastion does the clustering. Each site has one
primary node holding the authoritative object, plus any number of replica nodes serving reads.
Writes route to the primary; reads prefer a local replica.

```sh
bastion cluster init                  # on the first node
bastion cluster provision 10.0.1.0/24 # install children over SSH; dry run by default
bastion cluster place www.example.edu --replica node-b
```

Children dial out to the control node, which never dials in.

## Backups

Backups are content-addressed, delta-coded against the previous version and compressed, so cost
tracks churn rather than site size. They go to any of the object store drivers, including an
off-host bucket.

```sh
bastion backup now
bastion backup drill # restore into a scratch tenant and prove it boots
```

`drill` is scheduled by default. A backup nobody has restored is not a backup.

## Updates

workerd is pinned by binary digest and verified on download. An update rolls out one tenant at a
time, health-checks, then continues; `bastion rollback` returns to the previous pin.

Two things a rollback refuses. It will not cross a storage format change without a verified backup,
because that is not a rollback. And it will not go below the security floor without
`--force-below-floor`, which names the CVE you are accepting and records it in the audit log.

## Commands

| Group     | Commands                                                      |
| --------- | ------------------------------------------------------------- |
| Lifecycle | `init` `up` `down` `restart` `reload` `serve`                 |
| Inspect   | `status` `doctor` `health` `diagnose` `metrics` `logs` `tail` |
| Config    | `config show\|where\|get\|set\|validate\|schema\|edit`        |
| Tenants   | `tenant list\|add\|show\|rm\|suspend\|resume\|limits\|egress` |
| Sites     | `site list\|add\|show\|rm\|probe`                             |
| Delivery  | `deploy` `version` `rollout` `rollback`                       |
| Repair    | `repair` `quarantine` `recycle`                               |
| Backup    | `backup now\|list\|verify\|prune\|restore\|drill\|estimate`   |
| Secrets   | `secrets set\|get\|list\|rm\|rotate\|seal\|unseal`            |
| Certs     | `cert list\|issue\|renew\|import\|trust\|untrust`             |
| Egress    | `egress show\|allow\|deny\|test`                              |
| Cluster   | `cluster init\|join\|leave\|nodes\|place\|promote\|provision` |
| Capacity  | `capacity`                                                    |
| Migrate   | `migrate survey\|plan\|run\|resume`                           |
| Audit     | `audit tail\|export\|verify`                                  |
| Updates   | `update check\|apply\|rollback`                               |

`bastion manual` is the full reference, shipped inside the binary and readable with the network
down. Every command takes `--json`, which prints the same object the text output is rendered from.

## Limits

- **A site's primary node is a single point of failure for writes to that site.** Promoting a
  replica makes its snapshot authoritative and loses anything not yet replicated, bounded by the
  replica lag setting.
- **`isolateMemory` is enforced per tenant, not per isolate.** A cgroup bounds a process; one site
  can consume its tenant's whole budget.
- **Subrequest counts and the startup budget are declared, not enforced.** They are inside the
  isolate, where bastion cannot see them. `doctor` prints which is which.
- **HTTP/3 is off.** WebSockets do not work over h3, the `Alt-Svc` advertisement cannot be
  suppressed, and published measurements show QUIC losing to HTTP/2 on fast networks. Front bastion
  with Caddy or nginx if you want it.

## License

MIT
