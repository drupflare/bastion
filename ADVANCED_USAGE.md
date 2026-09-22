# Advanced Usage

Worked flows for things the manual describes one command at a time.

- [Bringing Up a Two-Node Cluster](#bringing-up-a-two-node-cluster)
- [Moving a VPS Onto a Box](#moving-a-vps-onto-a-box)
- [Wiring an Institutional CA](#wiring-an-institutional-ca)
- [An Air-Gapped Install](#an-air-gapped-install)
- [Restoring Into a Scratch Tenant](#restoring-into-a-scratch-tenant)
- [Sizing a Purchase](#sizing-a-purchase)
- [Delegating a Department](#delegating-a-department)
- [Turning Capabilities Off](#turning-capabilities-off)
- [Bringing Your Own Redis](#bringing-your-own-redis)
- [Running Under systemd](#running-under-systemd)

## Bringing Up a Two-Node Cluster

On the first box:

```sh
bastion init
bastion cluster init
bastion up
```

`cluster init` makes this node the control node and mints a join token with a short expiry. Print
it, then provision the second box from the first:

```sh
bastion cluster provision 10.0.1.12 --yes
```

That installs the pinned binary over SSH and writes a child configuration derived from the running
primary. Nothing is provisioned with a secret in it: the child receives the control node's address
and the one-time token, then dials out for the rest.

Give a site a replica:

```sh
bastion cluster place www.example.edu --replicas 1
bastion cluster nodes
```

A write now lands on the primary node and a read on the serving path is answered by whichever node
received it, when that node holds a replica.

Two things are worth checking before you trust it. Both nodes must forward a byte-identical `Host`
header, because Drupal derives its session cookie name from the host and a node forwarding a
different one renders every visitor anonymous. And the site must have rendered a page carrying a
CSRF token at least once, because the private key that page mints is what a replica waits for; a
freshly migrated site without one refuses every replica for a reason that reads like a capacity
limit.

To move a site's primary:

```sh
bastion cluster promote www.example.edu node-b
```

That prints the worst-case window of writes that may be lost before it acts, bounded by the
replication lag. It refuses without `--yes`.

## Moving a VPS Onto a Box

```sh
bastion migrate survey ssh://root@old.example.edu
bastion migrate plan ssh://root@old.example.edu
bastion migrate run ssh://root@old.example.edu --yes
```

`survey` finds every site on the host. You do not list them.

`plan` is a dry run and prints three things: each site with its size and whether it fits this
host's capacity, what will not carry, and the destination's binding term. Read the second list
before you commit. PHP extensions compiled into the origin, server-level rewrites, system cron
entries outside the CMS, TLS certificates and server mail configuration do not carry, and each one
says why.

`run` checkpoints at the site boundary, so a failure on the tenth site does not re-move the first
nine. Re-run it, or `bastion migrate resume`, and it picks up where it stopped.

Nothing is deleted at the source.

## Wiring an Institutional CA

A university with its own PKI does not want ACME. Issue the certificate through your own process
and import the chain:

```sh
bastion cert import www.example.edu ./fullchain.pem
bastion cert list
```

`cert list` reads `notAfter` from the certificate itself, so a one-year institutional certificate
is not renewed eleven months early against a rate limit. The expiry ladder still applies: warn at
21 days, error at 7, critical at 2.

To produce a signing request for your CA to sign:

```sh
bastion cert issue www.example.edu --csr-only > www.example.edu.csr
```

## An Air-Gapped Install

Nothing in the serving path needs the internet. The three things that normally reach out are ACME,
the workerd download and the backup target.

Use the file secrets driver rather than a KMS, import certificates rather than issuing them, and
verify the workerd binary against the pin by hand:

```yaml
runtime:
  workerd: { version: '1.20260828.1', verify: sha256 }
drivers:
  secrets: { driver: file, path: /var/lib/bastion/secrets/secrets.age }
backup:
  target: { driver: fs, root: /mnt/backup }
```

`bastion doctor` still works with no network. The manual is embedded in the binary, so
`bastion manual tls` works too.

One thing does degrade: `bastion doctor` resolves the pinned workerd's V8 version from workerd's
own build file over the network, and answers `unknown` rather than guessing when it cannot reach
it.

## Restoring Into a Scratch Tenant

Never test a restore by restoring over the live site.

```sh
bastion backup verify www.example.edu
bastion backup restore www.example.edu --to scratch --at 41
```

`verify` checks that every frame the manifest names is present and hashes to what it claims. It is
cheap and it is not the same test as a restore.

`bastion backup drill` does the whole thing on a schedule: restores the newest backup into a
scratch tenant, boots it, runs the site's probe, compares a rendered page byte for byte, and tears
it down. A drill that has never run is a warning rather than silence.

## Sizing a Purchase

`bastion capacity` is authoritative because it has read the actual host. Before you own the box,
the estimates in the manual will get you close.

```sh
bastion capacity
bastion capacity --what-if 200
```

Read the provenance column. An answer carrying an `assumed` input says so, and the first backup or
two will promote several of those terms to `probed` as bastion measures the real per-site cost on
your hardware.

Under the default `evict` residency, disk bounds how many sites can exist and RAM bounds how many
can be resident at once. Those are different numbers and the answer reports both. Under `pin` they
collapse into one, and a configuration that cannot fit is refused at validation time with both
numbers named.

## Delegating a Department

Give a department its own tenant, a quota, and a credential that cannot reach anything else:

```sh
bastion tenant add chemistry --cpu 2 --memory 4Gi --max-sites 25
bastion access invite chemistry --role tenant-admin
```

The tenant-admin can create sites up to 25, deploy, roll back, and read that tenant's health, logs
and meters. They cannot change configuration, reach another tenant, or touch the host. The quota is
what makes that safe: they cannot exhaust the box, so handing them self-service costs you nothing
to watch.

For signup with no human in the loop, use a token rather than a person:

```sh
bastion api token create signup --tenant students --role tenant-admin
```

The form calls the management API with that token. The token carries the tenant the same way a
session does, so it cannot name another one.

## Turning Capabilities Off

A student site should not be running arbitrary code. Three capabilities are enforced in the
generated workerd configuration and cannot be reached around from inside the site:

```yaml
tenants:
  - name: students
    capabilities:
      codegen: false
      workerLoader: false
      diagnosticRoutes: false
      extensions: [curl, openssl]
```

`bastion tenant show students` prints each one with its enforcement point. Anything whose only
mechanism is a site variable is labelled declared rather than enforced, because a settings key in
the site's own KV flips it on a running site and that override wins over anything you deployed.

The diagnostic routes are the interesting case. The site's own flag gates five routes as one
switch, which its own notes record as a defect. bastion refuses them at the front door, per route
and per tenant, outside the site's control, so a compromised site cannot flip a value it never
sees.

## Bringing Your Own Redis

bastion depends on no Redis library. Pass a client that satisfies the shape:

```ts
import { createClient } from 'redis';
import { redisKv, defaultContext } from '@drupflare/bastion';

const client = createClient({ url: 'redis://127.0.0.1:6379' });
await client.connect();

const kv = redisKv(defaultContext(), client, 'redis', 'bastion:');
await kv.probe();
```

The contract probes for the optional halves, so `node-redis` spelling `mGet` and `ioredis`
spelling `mget` both satisfy it. The probe also settles the binary question: it writes one
non-UTF-8 byte and reads it back, and values ride raw when that survives and base64 when it does
not. A client that silently decodes bytes as UTF-8 would otherwise corrupt a cached image with
nothing reporting it.

## Running Under systemd

```ini
[Unit]
Description=bastion
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
ExecStart=/usr/local/bin/bastion serve
Restart=on-failure
RestartSec=5
Environment=BASTION_CONFIG=/etc/bastion/bastion.yml

[Install]
WantedBy=multi-user.target
```

`serve` runs in the foreground, which is what `Type=exec` wants. Do not add systemd's own sandbox
directives to this unit: bastion applies a syscall filter, a namespace and an AppArmor profile per
tenant, and hardening the supervisor itself stops it from being able to.
