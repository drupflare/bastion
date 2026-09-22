<div style="display: flex; align-items: center; flex-direction: column;" align="center">
    <img align="center" style="align-self: center; max-width: 256px" src="./assets/bastion.png" width="30%" alt="" />
    <h1 style="text-align: center;">bastion</h1>
    <p style="text-align: center;">A hardened operating environment for self-hosted workerd.</p>
    <div align="center">
        <img src="https://img.shields.io/github/v/release/drupflare/bastion">
        <img src="https://img.shields.io/github/license/drupflare/bastion">
        <img src="https://img.shields.io/github/stars/drupflare/bastion?style=flat">
        <img src="https://img.shields.io/github/commit-activity/t/drupflare/bastion?color=violet">
    </div>
</div>

---

workerd is not a hardened multi-tenant sandbox, and its own repository says so. A private
deployment running mutually untrusted tenants needs a VM, container or microVM boundary around it.
Cloudflare Workers is workerd plus a hardened operating environment. bastion is that environment,
as a single binary you run on your own hardware.

## Table of Contents

- [Install](#install)
- [Getting Started](#getting-started)
- [What It Does](#what-it-does)
- [Isolation Modes](#isolation-modes)
- [Platform Limits](#platform-limits)
- [Configuration](#configuration)
- [Clustering](#clustering)
- [Drivers](#drivers)
- [Out of Scope](#out-of-scope)
- [Documentation](#documentation)
- [Development](#development)
- [License](#license)

## Install

```sh
curl -fsSL https://github.com/drupflare/bastion/releases/latest/download/bastion-linux-x64 -o bastion
install -m 0755 bastion /usr/local/bin/bastion
```

A container image is published to GitHub Packages:

```sh
docker run --rm ghcr.io/drupflare/bastion:latest bastion --version
```

## Getting Started

```sh
bastion init
bastion doctor
bastion tenant add acme --cpu 2 --memory 4Gi
bastion site add www.example.edu --tenant acme --bundle ./payload.tar.gz
bastion up
```

`bastion doctor` reads the host rather than the platform name. It prints which isolation
mechanisms are present, how each one was determined, which modes this host can run, and the limits
table with its enforced and declared column.

## What It Does

One workerd process per tenant, in every mode. A cgroup bounds that process for CPU, memory and
pids, with the OOM policy set so the kernel takes one tenant rather than the box.

A TLS front door in front of it. workerd carries exactly one keypair per socket and cannot route
by hostname, so bastion terminates TLS itself with SNI across every configured host, and workerd
listens behind it on a unix socket. The front door also owns what workerd has none of: per-IP and
per-tenant rate limits, a request body cap, a connection cap, response compression and HTTP/2.

Stores behind every binding. workerd ships the KV, R2 and Queues bindings and no stores, so bastion
supplies them: SQLite, Redis or Valkey for KV; disk, S3, R2, B2, GCS, Azure Blob, SFTP or FTP for
objects; SQLite, Postgres, MySQL or MariaDB for SQL. A cache with a memory tier in front of disk,
which is a throughput decision rather than a preference.

Backups that have been restored. Content-addressed at a fixed 16 KiB frame, encrypted, with a
scheduled drill that restores into a scratch tenant and renders a page from it.

The operational surface an institution needs: hash-chained audit, Prometheus with per-tenant
labels, ACME with renewal, deny-by-default egress in two layers, staged updates pinned by binary
digest, and a repair ladder that records how to undo everything it did.

## Isolation Modes

| mode       | boundary around each tenant                                   | multi-tenant safe |
| ---------- | ------------------------------------------------------------- | ----------------- |
| `solo`     | the host, plus cgroups v2                                     | no                |
| `hardened` | a network namespace, a syscall filter and an AppArmor profile | no                |
| `isolated` | one microVM per tenant                                        | yes               |

`solo` and `hardened` refuse to start with more than one tenant unless the operator passes an
acknowledgement flag. A Durable Object is a v8 isolate, and an isolate boundary is a correctness
boundary rather than a security one. Cloudflare has published a working Spectre read against
co-located Workers in production; on a single box, co-location is not something an attacker has to
win.

A mechanism that a preflight used to find and no longer finds never downgrades the mode. bastion
refuses and names what disappeared.

## Platform Limits

Standalone workerd enforces no isolate memory cap, no CPU limit, no subrequest cap and no startup
budget. bastion enforces what it can and declares the rest.

| limit          | Cloudflare | standalone workerd | bastion                                   |
| -------------- | ---------- | ------------------ | ----------------------------------------- |
| isolate memory | enforced   | none               | enforced per tenant, declared per isolate |
| CPU            | enforced   | none               | enforced per tenant                       |
| subrequests    | enforced   | none               | declared                                  |
| startup time   | enforced   | none               | declared                                  |
| alarms         | 15 minutes | 15 minutes         | inherited                                 |

The Cloudflare values are defaults and floors here. A configuration may raise any of them and may
never lower one, because the site payload is optimised around them.

## Configuration

`bastion.yml`, validated against a published JSON Schema:

```yaml
# yaml-language-server: $schema=https://bastion.drupflare.dev/schema.json
version: 1
mode: isolated
state: /var/lib/bastion
listeners:
  https: { address: '0.0.0.0:443' }
  management: { address: '127.0.0.1:8787' }
runtime:
  workerd: { version: '1.20260828.1', verify: sha256 }
  residency: evict
tenants:
  - name: acme
    limits: { cpu: '2', memory: 4Gi, maxSites: 40 }
    egress: { allow: ['smtp.example.edu:587'] }
    capabilities: { codegen: false, diagnosticRoutes: false }
    sites:
      - host: www.example.edu
        bundle: ./payload.tar.gz
        probe: drupflare
```

Secrets never appear in this file. `bastion config where` prints where each resolved value came
from, and `bastion config set` writes back through the same validator the dashboard uses.

## Clustering

workerd has no clustering: objects are always local to one runtime instance. bastion supplies the
cluster.

```sh
bastion cluster init
bastion cluster provision 10.0.1.0/24
bastion cluster place www.example.edu --replicas 1
```

Each site has one primary node and zero or more replica nodes. Writes and anything off the serving
path go to the primary; reads on the serving path are served locally where a replica exists.
Children dial out to the control node and it never dials in.

`cluster provision` installs bastion on a host, a list or a CIDR over SSH. A range is dry-run by
default, refuses above a /24 without an explicit flag, and skips a host that already has a bastion
state directory rather than overwriting it.

## Drivers

Every driver sits behind one contract with a capability object that is probed once and cached.
A probe that cannot run returns conservative answers, so an unknown endpoint degrades to more
requests rather than to failed ones. Two rules bind every driver: never return partial content,
and refuse a write it cannot honour rather than dropping part of it.

Redis, SFTP, FTP and the three SQL servers take a client the operator supplies. The contracts are
structural and probe for the optional halves, so node-redis and ioredis both satisfy the same one
and bastion depends on neither.

## Out of Scope

Point-in-time recovery to the second. Snapshot, delta, retention, restore, verify, prune and drill
are in.

HTTP/3. Bun ships it, and it is off here: WebSocket over h3 is unsupported and bastion needs
WebSockets, the `Alt-Svc` advertisement cannot be suppressed, and a campus firewall blocking UDP
443 turns that into one failed QUIC attempt per client cached for a day. Front bastion with Caddy
or nginx for h3.

Content permissions. The CMS has roles; bastion has three infrastructure roles and a per-site owner
token.

Pairing with a hosted control plane. `bastion pair` refuses and names the reason.

## Documentation

- [`MANUAL.md`](MANUAL.md) is the operator reference, also embedded in the binary: `bastion manual tls`
- [`docs/commands.md`](docs/commands.md) is every command, generated from the program
- [`ADVANCED_USAGE.md`](ADVANCED_USAGE.md) is worked flows

## Development

```sh
bun install
bun run typecheck
bun run test
bun run check:reachability
bun run build:binary
```

The gate lane is hermetic and runs in under two seconds. Anything needing a live dependency is in
the e2e lane behind an explicit flag:

```sh
REQUIRE_PAYLOAD=1 bun run test:e2e # a real workerd and the release payload
REQUIRE_DOCKER=1 bun run test:e2e  # the compose stack: redis, minio, postgres, an ssh target
REQUIRE_CLUSTER=1 bun run test:e2e # two nodes
REQUIRE_KVM=1 bun run test:e2e     # the isolated lane
```

## License

MIT
