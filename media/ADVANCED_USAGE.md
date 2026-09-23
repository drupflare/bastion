# Advanced Usage

Worked flows for things the manual describes one command at a time.

- [Running a Tenant in a microVM](#running-a-tenant-in-a-microvm)
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
- [Rendering With a Headless Browser](#rendering-with-a-headless-browser)
- [Installing From a URL](#installing-from-a-url)
- [The Default drupflare Payload](#the-default-drupflare-payload)
- [Bringing Your Own Redis](#bringing-your-own-redis)
- [Running Under systemd](#running-under-systemd)

## Running a Tenant in a microVM

`isolated` is the only mode that is multi-tenant safe, and it needs three things bastion does not
ship. Check the first one before anything else:

```sh
ls -l /dev/kvm
bastion doctor
```

`/dev/kvm` is owned by `root:kvm` on a stock Ubuntu, so the account running bastion joins that
group and logs in again:

```sh
sudo usermod -aG kvm bastion
```

A bare-metal host, or a VM with nested virtualisation turned on, can do this. Most VPS instances
cannot, and `doctor` says which case you are in rather than letting `up` find out.

Second, the hypervisor. The release archive names its binaries after the version, so install them
under the plain names bastion looks for:

```sh
tar xzf firecracker-v1.17.0-x86_64.tgz
sudo install -m 0755 release-*/firecracker-* /usr/bin/firecracker
sudo install -m 0755 release-*/jailer-* /usr/bin/jailer
```

Third, the guest image. It carries the pinned workerd, so it is built rather than downloaded:

```sh
core/scripts/guest-image.sh /var/lib/bastion/guest ./workerd
```

Then name it and switch the mode:

```yaml
mode: isolated
runtime:
  guest:
    kernel: /var/lib/bastion/guest/vmlinux-6.1.128
    rootfs: /var/lib/bastion/guest/guest.ext4
```

`firecracker` and `jailer` take paths too, for an install somewhere other than `/usr/bin`. Without
`runtime.guest` the mode refuses to start rather than running the tenant on the host.

```sh
bastion up
bastion vm list
```

Each tenant now boots its own microVM, and no workerd runs on the host at all. The guest takes a
few seconds longer to answer its first request than a process does, because it is booting a kernel
and mounting two drives before the runtime starts.

### What Crosses the Boundary

The guest has no network interface. Two drives go in and everything else is vsock:

| what                          | how                                                    |
| ----------------------------- | ------------------------------------------------------ |
| the capnp and the bundle      | a read-only drive mounted at `/srv/bastion`            |
| the site's storage            | the one writable drive, at `/var/lib/bastion/storage`  |
| a request from the front door | bastion dials the guest's vsock and asks for port 8080 |
| KV, R2, the cache, SQL        | the guest dials out, one vsock port per adapter        |

That is why the bundle travels with the configuration rather than staying on the host: the capnp
resolves its `embed` paths when workerd parses it, and workerd is parsing it inside the guest.

### When a Guest Will Not Start

Read its console. A guest that fails says why there and nowhere else:

```sh
bastion vm list
tail -40 /var/log/bastion/guests/acme.log
```

A kernel panic naming `/sbin/init` is the image, not bastion. A guest that boots and then answers
nothing is usually the runtime failing inside it, which the same file records.

## Bringing Up a Two-Node Cluster

Before anything, the first box needs an SSH key that reaches the second without a passphrase
prompt, because provisioning runs `ssh` with `BatchMode=yes`:

```sh
ssh-keygen -t ed25519 -C "bastion provisioning" -f ~/.ssh/bastion_provision
ssh-copy-id -i ~/.ssh/bastion_provision.pub root@10.0.1.12
```

Keep that private key on the control node only, mode `0600`. It installs software as root on every
box it reaches. `bastion manual credentials` covers every other key and where it lives.

On the first box:

```sh
bastion init
bastion cluster init --node node-a
bastion up
```

`cluster init` makes this node the control node and prints a join token that expires in an hour and
is spent by the first join. Provision the second box from the first:

```sh
bastion cluster provision 10.0.1.12 --yes
```

That installs the pinned binary over SSH. Or join by hand from the second box, which is the same
exchange:

```sh
bastion cluster join --control node-a:8787 --token node-b < token > --node
bastion up
```

A join carrying no token, a wrong one or a spent one is refused, and a refused join leaves the box
exactly as it was rather than half joined.

Each node advertises where its peers reach it. That is the node id by default, so set `advertise`
where the id is not a resolvable name:

```yaml
cluster:
  role: child
  control: { address: node-a:8787 }
  node: { id: node-b, advertise: 10.0.1.12 }
```

A node cannot advertise its own bind address: `0.0.0.0` accepts from every interface and no peer
can dial it.

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

The cluster wire is plaintext unless the management listener carries a certificate. A child dials
that listener, so on a cluster it binds more than loopback and `up` says so on every start. The
join token and the node credential both cross it, so put the cluster on a private network or issue
a certificate for the management address and point `--control` at `https://`.

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
carry the published digest in with the binary:

```yaml
runtime:
  workerd:
    version: '1.20260828.1'
    verify: sha256
    digest: 3f9c1e...
drivers:
  secrets: { driver: file, path: /var/lib/bastion/secrets/secrets.age }
backup:
  target: { driver: fs, root: /mnt/backup }
```

`digest` is the only way to check the bytes you carried in are the bytes upstream published, because
nothing on this box can ask. Without it bastion records what the staged binary hashed on first sight
and compares on every start after that, which catches a later swap on disk and trusts the first one.

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
  vectorize:
    driver: memory
    dimensions: 768
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

Both drivers are named because both bindings are. A site that binds a slot whose driver is unset
is refused by `bastion config validate` with the setting it needs, rather than starting and
answering 501 the first time somebody uses it.

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

## Rendering With a Headless Browser

No server image ships a browser and bastion installs nothing on its own, so the driver is off
until an operator turns it on:

```sh
bastion capability list
bastion capability install browser
```

Then configure it and grant the tenant the capability:

```yaml
drivers:
  browser: { driver: chromium }

tenants:
  - name: chemistry
    capabilities: { browser: true }
    sites:
      - host: www.chem.example.edu
        bundle: ./worker.tar.gz
        worker:
          main: index.js
          browser: true
```

`driver: chromium` runs `chromium` from `PATH`; `driver: chrome` runs `chrome`; `command` names a
binary somewhere else. `driver: devtools` points at a browser the operator already runs, and takes
`devtoolsUrl`.

The site calls the binding the way it does on Cloudflare:

```js
export default {
  async fetch(request, env) {
    const png = await env.BROWSER.screenshot({
      url: 'https://www.chem.example.edu/notice/1',
      viewport: { width: 1200, height: 630 }
    });
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  }
};
```

`screenshot`, `pdf` and `content` each take a `url` or an `html` string. `@cloudflare/puppeteer`
takes the binding itself and upgrades it to the browser's CDP socket, which bastion proxies rather
than interprets.

A render fetches a url of the site's choosing from the host's own network position, so three
targets are refused before a browser starts:

```
a render may not reach 169.254.169.254; that is the host's own network, not the tenant's
bastion renders http and https, not file
renders are limited to example.edu
```

The first covers loopback, link local and the private ranges, which is the metadata service, the
management listener and every other tenant's admin port. The second stops a render reading the
disk. The third is the tenant's own egress allow list, applied to renders as well as to `fetch`.
In `hardened` and `isolated` the browser runs inside the tenant's network namespace, which is the
layer that holds when a browser bug gets past the first three.

To run a browser without installing one on the host, the compose stack carries a chromium service:

```sh
docker compose -f docker/compose.yml up -d --wait chromium
REQUIRE_DOCKER=1 bun run --cwd core test:e2e -- browser-render
```

## Installing From a URL

`--bundle`, `--template` and the `deploy` argument each take a path or an `https` url:

```sh
bastion site add www.example.edu --tenant acme \
  --template https://github.com/example/worker/releases/download/v2/template.tar.gz

bastion deploy www.example.edu \
  https://releases.example.edu/payload-1.0.2.tar.gz \
  --checksum sha256:eb333942340dfa7da54597d78b894f35310289e75ec3a84137a197a37ab1d164
```

A url is fetched once. What lands on disk is what the config records, so a later `bastion up` does
not re-download, and a site's code does not change because someone else's server did.

bastion asks with `HEAD` first and refuses on the answer rather than after spending the bandwidth:

```
https://releases.example.edu/p.tgz is 402653184 bytes, over the 268435456 ceiling
http://releases.example.edu/p.tgz is plaintext, and this becomes a tenant's code
mirror.example.edu resolves to 169.254.169.254, which is in 169.254.0.0/16: the host's
own network, not the internet
```

Every hop of a redirect chain is checked, not the url that was typed, so a public host cannot
redirect the download into the private ranges. The chain stops at five hops.

`--checksum` takes `sha256:<hex>` or the bare hex and is compared against what arrived. Without
one the digest is still computed and printed, so it can be recorded and demanded on the next
install.

For a mirror on the operator's own network, `--insecure-source` accepts plaintext and a private
address:

```sh
bastion deploy www.example.edu http://mirror.internal:8080/payload.tar.gz --insecure-source
```

## The Default drupflare Payload

A site with no `worker` block gets the drupflare shape, which is what `bundle: ./payload.tar.gz`
means in every example here. The payload is the release artifact from
[drupflare/worker](https://github.com/drupflare/worker): Drupal with its PHP interpreter compiled
to WebAssembly, the modules and themes it ships with, and a per-file pack of core.

```yaml
tenants:
  - name: acme
    sites:
      - host: www.example.edu
        bundle: ./payload.tar.gz
        probe: drupflare
```

That expands to the bindings bastion emits when a site declares none:

| binding     | what it is                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `SITE`      | the Durable Object, class `SitePhpDurableObject`, one per hostname, holding that site's SQLite database |
| `ASSETS`    | the static files, served through a worker in front of the disk service rather than off a bare one       |
| `CONFIG_KV` | settings                                                                                                |
| `PAGE_KV`   | rendered pages                                                                                          |

The Cache API is wired separately. It is not a binding a site names, and workerd answers every
request with `500 No Cache was configured` when it is absent, so `drivers.cache` is never off. Its
hit rate is the difference between the object serving most anonymous traffic and all of it.

Inside the tarball:

| path                                             | what it is                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `manifest.json`                                  | the release, the commit, and every file with its size and sha256                         |
| `.interp/`                                       | the PHP interpreter modules, derived from the alias in the worker's own `wrangler.jsonc` |
| `assets/core`, `assets/modules`, `assets/themes` | Drupal itself                                                                            |
| `assets/drupal-pf/core.pf.json`, `core.pf.bin`   | the per-file pack; the site refuses to boot with either one missing                      |
| `assets/drupal-sql/`                             | the schema the first render installs                                                     |
| `assets/prefill.json`                            | the paths answered without a render                                                      |
| `assets/agg/`                                    | the built CSS and JS aggregates, absent from a payload built without them                |

`probe: drupflare` is the only place a CMS is named anywhere in bastion. It sets two things:
`.assetsignore` as the file the bundle ships to mark assets private, and `x-cfw-php-booted` as the
header that proves a render happened. `bastion site probe` asks for a path outside
`prefill.json` and reads that header, so a prefilled answer cannot pass for a boot.

An unknown profile name falls back to the generic profile, which expects no boot header: a worker
that is not a CMS sets none, and demanding one would fail a site that is serving.

`site.sqlite` is refused whatever the ignore file says. It is on the floor list under every
profile, because a disk service has no opinion about what it holds and an early smoke lane served
a whole site database publicly.

To install it from the release:

```sh
curl -fsSLO https://github.com/drupflare/worker/releases/download/v1.0.1/SHA256SUMS

bastion site add www.example.edu --tenant acme --probe drupflare \
  --bundle https://github.com/drupflare/worker/releases/download/v1.0.1/drupflare-worker-1.0.1.tar.gz \
  --checksum "$(grep drupflare-worker-1.0.1.tar.gz SHA256SUMS | cut -d' ' -f1)"

bastion up
bastion site probe www.example.edu
```

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
