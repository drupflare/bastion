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
- [Hosting a Plain Worker](#hosting-a-plain-worker)
- [Three Tiers on One Box](#three-tiers-on-one-box)
- [A Research Site With Inference, Vectors and a Database](#a-research-site-with-inference-vectors-and-a-database)
- [Running a Model on Your Own Box](#running-a-model-on-your-own-box)
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

## Hosting a Plain Worker

A tenant does not have to be a CMS. Give the site a `worker` block naming what its bundle exports
and what it wants bound.

```yaml
tenants:
  - name: api
    limits: { cpu: '1', memory: 1Gi }
    sites:
      - host: api.example.edu
        bundle: ./worker.tar.gz
        worker:
          main: server.js
          durableObjectClass: null
          assets: null
          kv: [SESSIONS]
```

The bundle is a directory of modules. The entrypoint leads and the rest follow in name order, so
two runs over one bundle generate the same configuration:

```text
worker.tar.gz
  server.js
  parser.wasm
```

```sh
bastion site add api.example.edu --tenant api --bundle ./worker.tar.gz
bastion up
bastion site probe api.example.edu
```

`site probe` reports status alone here. The boot header belongs to the `probe` profile, and a
worker that is not a CMS sets none.

What the generated configuration carries is exactly what the block asked for: a KV binding named
`SESSIONS` over bastion's own store, the mandatory cache, and a deny-by-default egress service. No
Durable Object namespace, no storage mount, no assets service. The tenant still gets its cgroup,
its front door, its rate limits and its certificate.

To give that worker an object, name both halves:

```yaml
worker:
  main: server.js
  durableObjectClass: Counter
  durableObject: COUNTER
```

Naming one half without the other is refused at validation rather than at workerd startup, where
it would read as a broken bundle.

## Three Tiers on One Box

A campus runs three kinds of site on the same hardware, and they must not be able to do the same
things. Groups state each tier once; the tenants are then two lines each.

```yaml
groups:
  campus:
    limits: { cpu: '4', memory: 8Gi }
    egress:
      allow: ['smtp.example.edu:587', 'updates.drupal.org:443']
    capabilities:
      extensions: [curl, openssl, gd, mbstring]

  students:
    extends: campus
    limits: { cpu: '1', memory: 1Gi, maxSites: 3 }
    capabilities:
      codegen: false
      diagnosticRoutes: false
      browser: false
      ai: false
      vectorize: false
      email: false

  departments:
    extends: campus
    limits: { maxSites: 50 }
    capabilities:
      browser: true
      email: true

  research:
    extends: departments
    limits: { cpu: '8', memory: 32Gi, maxSites: 10 }

drivers:
  ai: { driver: openai-compatible, endpoint: 'http://127.0.0.1:11434/v1' }
  vectorize: { driver: memory, dimensions: 768 }
  images: { driver: magick }
  browser: { driver: chromium }
  email: { driver: smtp, host: smtp.example.edu, port: 587 }

tenants:
  - name: undergrads
    group: students
    sites:
      - host: alice.sites.example.edu
        bundle: ./payload.tar.gz

  - name: chemistry
    group: departments
    sites:
      - host: chem.example.edu
        bundle: ./payload.tar.gz
      - host: public.chem.example.edu
        bundle: ./payload.tar.gz
        capabilities: { browser: false }

  - name: genomics
    group: research
    sites:
      - host: genomics.example.edu
        bundle: ./worker.tar.gz
        worker:
          durableObjectClass: null
          ai: [AI]
          vectorize: [INDEX]
          d1: [DB]
```

Read the last site in `chemistry` carefully. It withdraws browser rendering for one public site
while the rest of the department keeps it. That direction works; the opposite does not. A site
setting `browser: true` under `undergrads` changes nothing, because a capability narrows on the
way down and never widens. Without that rule a tenant-admin editing their own block could grant
back whatever you withdrew.

Check what a tenant actually resolved to:

```sh
bastion tenant show undergrads
bastion tenant show genomics
```

Each prints the capability table with an enforcement point against every row, after the group
chain has been applied.

Two failures are worth telling apart, and the validator names which one you hit:

```text
tenants[0].sites[0].worker.browser: BROWSER is withdrawn for this site;
  the box can do it and this tenant may not

tenants[2].sites[0].worker.images: IMAGES needs an image tool:
  install imagemagick and set drivers.images; it is off until you do
```

The first is policy and you fix it in `bastion.yml`. The second is a missing primitive and no
setting changes it:

```sh
bastion capability list
bastion capability install images
```

## A Research Site With Inference, Vectors and a Database

The `genomics` tenant above binds three things workerd has no field for. This is what the bundle
sees and where each piece actually runs.

```yaml
sites:
  - host: genomics.example.edu
    bundle: ./worker.tar.gz
    worker:
      main: server.js
      durableObjectClass: null
      d1: [DB]
      vectorize: [INDEX]
      ai: [AI]
      images: [IMAGES]
      email: [MAILER]
```

The Worker calls all five unchanged:

```js
export default {
  async fetch(request, env) {
    const embedding = await env.AI.run('bge-base-en', { text: 'ribosome' });
    const near = await env.VECTORIZE.query(embedding.data[0], { topK: 5 });
    const rows = await env.DB.prepare('select * from papers where id = ?')
      .bind(near.matches[0].id)
      .all();
    // render the answer here
    return Response.json(rows.results);
  }
};
```

None of `DB`, `INDEX` or `AI` is a real workerd binding. Each is a `wrapped` binding: an internal
module bastion declares in the generated configuration, handed a connection to the tenant's
adapter socket, whose return value becomes `env.DB`. It is the same mechanism miniflare uses to
serve D1 locally, and it is why the bundle needs no bastion-specific code.

`bastion site template ./worker.tar.gz` tells you this before you deploy:

```text
binding    declared as        why it does not carry
---------  -----------------  -----------------------------------------------
PIPE       pipelines          the ingest buffer that batches records into r2
                              is not built yet; write to the r2 binding directly

not scheduled: */15 * * * * -- bastion has no cron scheduler, so these never fire
```

Everything it does not list, it carries. The cron line is the one most likely to surprise you:
workerd has no cron trigger in its schema and no path that reaches a `scheduled()` handler, so a
timer in front of the node would have nothing to call. Periodic work belongs in a Durable Object
alarm, which workerd does run.

## Running a Model on Your Own Box

Workers AI is an API shape over a catalogue of open-weight models, so the models run wherever you
put them. Point the driver at an inference server and bind `AI` like any other slot.

```yaml
drivers:
  ai:
    driver: openai-compatible
    endpoint: http://127.0.0.1:11434/v1
    allow: [llama3.1:8b, nomic-embed-text]
tenants:
  - name: research
    sites:
      - host: ask.example.edu
        bundle: ./worker.tar.gz
        worker:
          durableObjectClass: null
          ai: [AI]
          vectorize: [INDEX]
```

The worker calls `env.AI.run()` and `env.VECTORIZE.query()` unchanged. Neither has a field in
workerd's schema, so bastion binds each through `wrapped`: an internal module gets a fetcher for
the adapter socket and returns the object the worker sees.

A model the endpoint does not serve is refused by name:

```text
this endpoint does not serve @cf/meta/llama-4; it serves llama3.1:8b, nomic-embed-text
```

The `allow` list is the operator's and wins over what the endpoint reports, which is how a shared
GPU stays bounded to the models you meant to publish.

### Offloading to Cloudflare

Opt-in, and there is no automatic failover to it:

```yaml
drivers:
  ai:
    driver: cloudflare
    accountId: <id>
    apiToken: <token>
    allow: ['@cf/meta/llama-3.1-8b-instruct']
```

A model outside `allow` is refused before the request is spent rather than after. An air-gapped
install leaves this unset and nothing reaches the internet.

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
