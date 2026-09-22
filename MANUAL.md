# bastion Manual

The operator reference. `bastion manual <topic>` prints any section of this file from the
binary, so a host with no network still has it.

## Contents

- [Reading This Manual](#conventions)
- [Getting Started](#getting-started)
- [Running](#running)
- [Configuration](#configuration)
- [Tenants](#tenants)
- [Groups](#groups)
- [Domains](#domains)
- [Sites](#sites)
- [Deploying](#deploying)
- [Diagnosing](#diagnosing)
- [Repairing](#repairing)
- [Observing](#observing)
- [Capacity](#capacity)
- [Backups](#backups)
- [Secrets](#secrets)
- [TLS](#tls)
- [Egress](#egress)
- [Isolation](#isolation)
- [Clustering](#clustering)
- [Access](#access)
- [Auditing](#auditing)
- [Adapters](#adapters)
- [Updating](#updating)
- [Migrating](#migrating)
- [Dashboard](#dashboard)
- [Pairing](#pairing)
- [Manual](#manual)

## Reading This Manual

<a id="conventions"></a>

Every command in this manual is written the same way, and nothing in it is a guess you
have to make. This section explains the notation once so the rest reads as instructions.

### Angle Brackets Mean You Substitute

Anything in angle brackets is a value you replace, brackets included. Where each one comes from:

    <host>       a hostname you own, e.g. www.example.edu
                 you type this; it is the address visitors will use

    <tenant>     a tenant name you chose, e.g. acme
                 you invented it when you ran `bastion tenant add`
                 `bastion tenant list` prints every one that exists

    <site>       the same thing as <host>; a site IS its hostname
                 `bastion site list` prints every one

    <code>       a tripwire code, e.g. host.disk_low or cert.expiring
                 you do NOT invent these. bastion prints one when it finds
                 something. `bastion diagnose` with no argument lists all
                 of them with what each means

    <version>    a deployed bundle's id, e.g. 7f3a91c
                 bastion prints it when you deploy
                 `bastion version list <site>` prints the history

    <node>       a node name in a cluster, e.g. node-b
                 you chose it in that node's bastion.yml
                 `bastion cluster nodes` prints every one

    <name>       a secret's name, e.g. smtp-password
                 you invented it when you ran `bastion secrets set`
                 `bastion secrets list` prints the names, never the values

    <path>       a file or directory on this machine, e.g. ./payload.tar.gz
                 a relative path is relative to where you are standing

    <topic>      a section of this manual, e.g. tls
                 `bastion manual --list` prints every one

### Square Brackets Mean Optional

`bastion manual [topic]` means the topic may be left off. Run it without and you get the list.

### Flags Start With Two Dashes

A flag changes how a command behaves. `--tenant acme` passes the value `acme`. Flags come after
the command and its arguments, and order among them does not matter. These work everywhere:

    --config <path>   read a different bastion.yml
    --json            print the result as JSON instead of a table
    --yes             do not ask for confirmation
    --quiet           print errors only
    --verbose         include a stack trace on an internal error
    --no-color        plain text, for a log file or a pipe

### What the Exit Codes Mean

Every command answers with a number the shell can test. In a script, `if bastion doctor; then`
reads that number.

    0   it worked
    1   it could not run: something was unreachable or a process failed
    2   you asked for something impossible: a bad flag, a name that does
        not exist, a value the validator refused
    3   it ran, and it FOUND something. `bastion health` exits 3 when
        there is an open finding. This is not a failure

### Where Things Live

    ./bastion.yml           the configuration; everything you set lives here
    /var/lib/bastion        the state directory: storage, logs, certificates
    127.0.0.1:8787          the dashboard and the management API

`bastion config where` prints, for every setting, which file or flag it came from.

### When a Command Refuses

A refusal names what to do next. If you see `next: bastion tenant list`, run that; it will show
you the names you could have used. A refusal is never a crash, and nothing is half-applied: the
command either did the whole thing or it did nothing.

## Getting Started

<a id="getting-started"></a>

bastion turns a bare Linux host into a hardened operating environment for workerd.

This section takes you from a fresh machine to a site answering over HTTPS. Every value below is
one you can type as written; where you have to substitute your own, it says so.

### 1. Write the Configuration

Stand in the directory you want to keep the configuration in. `/etc/bastion` is the usual choice:

    mkdir -p /etc/bastion
    cd /etc/bastion
    bastion init

That writes `bastion.yml` here and creates `/var/lib/bastion` for state. It asks nothing and
overwrites nothing: run it twice and the second run refuses rather than replacing your file.

### 2. Ask the Host What It Can Do

    bastion doctor

This reads the machine rather than its name. It prints which isolation mechanisms are present and
how each was determined, which of the three modes this host can run, and a limits table.

Read the limits table before anything else. Standalone workerd enforces no isolate memory cap, no
CPU limit, no subrequest cap and no startup budget. bastion enforces CPU and memory per tenant
through cgroups and declares the rest. A limit bastion cannot enforce is never reported as
enforced, so a row saying `declared, not enforced` means exactly that.

`doctor` exits 3 if it found something worth knowing. That is not a failure.

### 3. Create a Tenant

A tenant is one organisation or one customer. It is the security boundary: each tenant gets its
own workerd process and its own CPU and memory limit. Pick a short lowercase name; this one is
`acme`, and you would use whatever your department or customer is called:

    bastion tenant add acme --cpu 2 --memory 4Gi --max-sites 40

`--cpu 2` means two cores' worth. `--memory 4Gi` is four gibibytes. `--max-sites 40` is the
ceiling on how many sites this tenant may create, which is what makes it safe to hand the tenant
to somebody else. All three are optional; leaving one out means no limit.

Check it landed:

    bastion tenant list

### 4. Add a Site

A site is one hostname. You need two things: the hostname, and the bundle that serves it.

The hostname is yours, and DNS for it has to point at this machine. The bundle is a directory or
a tarball of JavaScript modules; for drupflare that is the release payload.

    bastion site add www.example.edu --tenant acme --bundle ./payload.tar.gz

Substitute `www.example.edu` for your own hostname and `./payload.tar.gz` for wherever your
bundle actually is. If you are deploying an ordinary Worker rather than drupflare, see
`bastion manual sites` for the `worker` block, or let bastion read the Worker's own manifest:

    bastion site template ./my-worker
    bastion site add api.example.edu --tenant acme --template ./my-worker

`site template` changes nothing. It reads the Worker's `wrangler.jsonc` and tells you which of
its bindings bastion will carry and which it will not, which is worth doing before you commit.

### 5. Start It

    bastion up
    bastion status

`up` pins and verifies workerd, generates a configuration per tenant, starts one workerd process
per tenant behind the front door, and brings up the dashboard on `127.0.0.1:8787`.

### 6. Check It Actually Works

    bastion site probe www.example.edu

This requests a path the cache cannot answer, so a success means the runtime really booted rather
than that something was cached. It exits 3 if the site did not answer.

### Shell Completion

Tab completion for bash, zsh and fish. Pick your shell:

    bastion completion bash > /etc/bash_completion.d/bastion
    bastion completion zsh  > ~/.zsh/completions/_bastion
    bastion completion fish > ~/.config/fish/completions/bastion.fish

Open a new shell afterwards.

## Running

<a id="running"></a>

`bastion serve` runs in the foreground and is what a systemd unit calls. `bastion up`
starts the same thing in the background and brings up the dashboard.

    bastion up
    bastion status
    bastion down

Each tenant gets one workerd process, in every mode. That is what makes a cgroup limit bind to
something, lets a tenant change restart one tenant rather than the box, and keeps a Durable Object
consistency domain per tenant.

workerd has no live configuration reload. Its `--watch` execs the binary over itself, which
clears close-on-exec so listening sockets survive, but in-flight connections drop and all
in-memory Durable Object state is lost. So `bastion reload` restarts only the tenants whose
generated configuration changed: it starts the replacement, health-checks it, swaps the upstream,
and drains the old one.

`solo` and `hardened` refuse to start with more than one tenant unless you pass the
acknowledgement flag. One tenant is always fine; there is nobody to isolate it from.

## Configuration

<a id="configuration"></a>

bastion.yml is read from $BASTION_CONFIG, then ./bastion.yml, then
/etc/bastion/bastion.yml. Precedence is flag, then environment, then file, then default, and
`bastion config where` prints where each resolved value came from.

    bastion config show
    bastion config where
    bastion config validate

The JSON Schema is published so an editor can complete the file:

    # yaml-language-server: $schema=https://bastion.drupflare.dev/schema.json

`bastion config schema` prints the same schema. The runtime validator is hand written and
reports the path of every rejection; a parity test runs both over one corpus so they cannot drift.

Secrets never appear in this file. See `bastion manual secrets`.

Limits are floors. The Cloudflare values are defaults here and a configuration may raise any of
them and may never lower one, because the site payload is optimised around them. The validator
refuses a lower value and names the floor.

## Tenants

<a id="tenants"></a>

A tenant is the isolation unit and the security principal: one organisation or one
customer, holding one or more sites. A site belongs to exactly one tenant and has exactly one
primary node.

    bastion tenant add acme --cpu 2 --memory 4Gi --max-sites 40
    bastion tenant show acme
    bastion tenant list

`tenant show` prints the capability block with an enforcement point against each entry. Three
capabilities are enforced in the generated workerd configuration and cannot be reached around:
runtime codegen, dynamic Worker loading and the cross-isolate memory cache. The diagnostic routes
are enforced at the front door, per route, outside the site's control. Anything whose only
mechanism is a site variable is labelled declared rather than enforced, because eighteen levers
are overridable from the site's own KV and an override wins over anything bastion deployed.

Arbitrary PHP evaluation is remote code execution by design, which is why Drupal marks its own
Execute PHP Code permission restricted and why core removed the PHP filter. bastion declines
codegen by default; a tenant that needs it turns it on per tenant and the audit log records who
did.

PHP extensions are an operator-curated catalogue. A dynamically linked library shares the host's
whole memory and table, so a user-supplied library cannot be a tenant-supplied extension. The
operator publishes the set and a tenant selects from it.

## Groups

<a id="groups"></a>

A group is a named set of settings that tenants and sites start from. You define it
once and point as many tenants at it as you like, which is what keeps a cluster of ten nodes from
being ten copies of the same paragraph.

Groups live in `bastion.yml` under a top-level `groups` key. Nothing creates them from the
command line; you write them in the file, because they are a policy rather than an action.

### A Worked Example

    groups:
      campus:
        limits: { cpu: "4", memory: 8Gi }
        egress:
          allow: ["smtp.example.edu:587", "updates.drupal.org:443"]
      students:
        extends: campus
        limits: { cpu: "1", memory: 1Gi, maxSites: 3 }
        capabilities:
          codegen: false
          browser: false
          ai: false
      departments:
        extends: campus
        limits: { maxSites: 50 }

    tenants:
      - name: chemistry
        group: departments
        sites:
          - host: chem.example.edu
            bundle: ./payload.tar.gz
      - name: undergrads
        group: students
        sites:
          - host: alice.sites.example.edu
            bundle: ./payload.tar.gz

`chemistry` gets four cores, eight gibibytes, the campus egress list and a fifty site ceiling.
`undergrads` gets one core, one gibibyte, the same egress list, three sites, and no browser, no
inference and no runtime codegen. Neither tenant restates any of it.

### How a Value Is Decided

Three layers, narrowing, in this order:

    1. the group the tenant names, and anything that group extends
    2. the tenant's own block
    3. the site's own block

Later layers override earlier ones field by field. A tenant setting `maxSites` keeps every other
value its group set.

### Capabilities Only Ever Narrow

This is the one rule worth learning. A lower layer can turn a capability OFF and can never turn
one back ON. If `students` sets `browser: false`, a tenant in that group cannot set
`browser: true`, and neither can one of its sites.

That is deliberate. A tenant-admin can edit their own tenant's block; if they could widen a
capability, everything the operator withdrew would be a suggestion. The same holds for the PHP
extension catalogue, which narrows to the intersection rather than accepting additions.

A site may still withdraw something its tenant allows, which is how one site inside a department
runs without browser rendering while the rest of the department keeps it:

    - host: public.example.edu
      bundle: ./payload.tar.gz
      capabilities: { browser: false }

### Groups May Extend Groups

`extends` points at another group and inherits it first. Chains are resolved outermost first and
are capped at eight deep. A group extending a name that does not exist is refused, and so is a
cycle; both are named at validation rather than resolving to something surprising.

### Seeing What Resolved

    bastion tenant show chemistry

That prints the capability table with an enforcement point against each entry, after the group
chain has been applied. It is the answer to "why can this tenant not do that".

### Two Different Refusals

A capability turned off here is a POLICY refusal: the box can do it and this tenant may not.

That is different from a MISSING primitive, which is a hard refusal: ImageMagick is not installed,
so nothing on this host can bind Images and no setting changes it. `bastion capability list`
answers the second question; this section answers the first. The validator says which one you hit.

## Domains

<a id="domains"></a>

Most sites get a name under one primary domain the institution already owns. That is
the default path and it needs no proof of ownership, because the institution owns the zone.

    bastion config set domains.primary sites.example.edu
    bastion domain add alice --tenant students
    bastion domain list

A label is refused if it is not valid DNS, if it is reserved, or if it is taken. `www`, `admin`,
`api` and the challenge prefixes are reserved, because those names under an institution's own
domain read as the institution rather than as one student. `bastion domain suggest alice` answers
with the nearest free name.

A name outside the primary domain is a custom root and is off by default:

    bastion config set domains.allowCustomRoots true
    bastion domain add www.example.org --tenant acme
    bastion domain token www.example.org
    bastion domain verify www.example.org

`domain token` prints the TXT record that proves the tenant owns the name. The token is derived
from an install secret and from the tenant, so printing it again does not invalidate what was
already published, and one tenant cannot pre-publish a record that would later validate another
tenant's claim on the same name.

`domain verify` runs three checks and says what to publish for each one that fails. Ownership is
the TXT record above. DNS is whether the name resolves to an address this node answers on. CAA is
whether the domain's own policy permits the CA bastion is configured to use, which is the check
that matters most: a CAA record naming a different CA makes issuance fail inside the CA, with an
error the operator never sees.

Aliases reach the same site and go on the same certificate:

    bastion domain add www.example.org --alias example.org

Set `canonical` on the site to redirect every alias to one name. Two names serving identical
content is two session cookie scopes and two cache entries, so picking one is usually right, but
serving each alias as itself is supported and is what happens when `canonical` is unset. The
redirect is a 308 rather than a 301, because a 301 lets a client turn a POST into a GET and a form
submitted to the wrong name would arrive with its body dropped.

DNS records can be created for you where a provider is configured. Today that is Cloudflare, with
a token scoped to Zone.DNS edit on the zones bastion manages. The provider contract is four
methods, so another one is written rather than waited for. With no provider, bastion prints the
records and you publish them.

## Sites

<a id="sites"></a>

A site is one hostname. Its Durable Object id is derived from that hostname.

    bastion site add www.example.edu --tenant acme --bundle ./payload.tar.gz
    bastion site probe www.example.edu
    bastion site list

`site add` consults the capacity model. With `limits.maxSites` set it refuses past the ceiling
and names both the count and the binding term; without one it warns past the recommendation and
proceeds, so a deliberately low ceiling reads as a choice rather than a fault.

`site probe` requests a path that is not in the prefill set, which is what proves a real boot
rather than a cached answer. The header it reads comes from the site's `probe` profile. A site
with no profile is answered on status alone, because a worker that is not a CMS sets no boot
header and demanding one would fail a site that is serving.

A site declares what its bundle exports and what it expects to be bound. Leaving the `worker`
block out gives the drupflare shape, which is what every site carried before the block existed.

    sites:
      - host: api.example.edu
        bundle: ./worker.tar.gz
        worker:
          main: server.js
          durableObjectClass: null
          kv: [SESSIONS]
          queues: [JOBS]

`main` is the entry module, inferred when the bundle names it index.js, index.mjs, worker.js,
main.js or site.js, or when the bundle holds exactly one script. `durableObjectClass` is the
class the bundle exports and defaults to SitePhpDurableObject; null means the worker has no
object. `durableObject` and `assets` are the bindings those two are reached by, defaulting to
SITE and ASSETS. `kv`, `r2`, `queues`, `d1`, `vectorize` and `ai` are binding names
per adapter slot. `compatibilityDate` and `compatibilityFlags` are passed to workerd unchanged.

Three of those slots have no field in workerd's schema at all. D1, Vectorize and Workers AI are
Cloudflare APIs rather than runtime primitives, so bastion binds each one through `wrapped`: an
internal module is instantiated with a fetcher for bastion's adapter socket, and whatever that
module returns becomes the value of the binding. A site gets the module only when it binds the
slot, so a worker that wants none of them runs with no bastion javascript in it.

What sits under each one is the operator's:

    drivers:
      d1: { driver: sqlite }
      vectorize: { driver: memory, dimensions: 768 }
      ai: { driver: openai-compatible, endpoint: http://127.0.0.1:11434/v1 }

Workers AI is self-hosted by default. Cloudflare publishes an open-weight catalogue, so the same
models run on a box with a GPU, and the `openai-compatible` driver reaches ollama, vLLM,
llama.cpp's server or LM Studio without bastion depending on any of them. A model the endpoint
does not serve is refused by name rather than substituted.

Offloading to Cloudflare is available and is opt-in:

    drivers:
      ai:
        driver: cloudflare
        accountId: <id>
        apiToken: <token>
        allow: ["@cf/meta/llama-3.1-8b-instruct"]

There is no automatic failover from a local endpoint to that one. A silent egress of tenant
prompts to a third party is not something to discover from a bill, and on an air-gapped install it
would fail with a confusing error rather than an honest one. `allow` bounds both the policy and
the spend, and is checked before the request rather than after the response.

A slot with no name gets no binding and no service, so a worker that wants none of them runs under
a configuration with none of them in it. The cache is the exception and is always attached:
without cacheApiOutbound every request answers 500.

Cron triggers do not run. workerd carries no cron field in its schema and serves no path that
reaches its scheduled handler, so a timer in front of the node has nothing to call and a bundle's
`scheduled()` export never fires. `site add --template` prints the cron expressions a manifest
declares rather than accepting them silently. Work that must happen on a schedule belongs in a
Durable Object alarm, which workerd does run.

A bundle holding several scripts and naming no entrypoint is refused rather than guessed. Naming a
class without a binding, or a binding without a class, is refused at validation: either half alone
produces a configuration workerd will not start, and a startup failure reads as a broken bundle
rather than a typo.

## Deploying

<a id="deploying"></a>

Versions are content addressed, so two identical uploads are one version and a
rollback is a pointer move rather than a re-upload.

    bastion deploy www.example.edu ./payload-1.0.2.tar.gz
    bastion versions list www.example.edu
    bastion rollout www.example.edu --version <id> --percent 10
    bastion rollback www.example.edu

The rollout split is real: the front door sends that share of traffic to the canary version.
Traffic is split on a stable key rather than per request, so a visitor stays on one side for the
whole of a session. Splitting per request would show one user half of each version, which on a CMS
carrying a session cookie produces a support ticket rather than a signal.

`rollback` with no argument returns to the version before the current one. It refuses when there
is nothing behind the current version rather than reinstalling it.

## Diagnosing

<a id="diagnosing"></a>

Three commands answer three different questions.

    bastion doctor          what this host can do
    bastion health --tree   what is wrong right now
    bastion diagnose <code> what one finding means and what bastion did about it

### Where `<code>` Comes From

You never invent a code. bastion prints one when it finds something, and every code is a fixed
string from a list bastion ships. To see the whole list with what each one means:

    bastion diagnose

That prints a table of every code, its severity, and the command that repairs it. Then look one
up by name:

    bastion diagnose host.disk_low
    bastion diagnose cert.expiring
    bastion diagnose runtime.crash_loop

The codes are grouped by what they are about, and the prefix tells you where to look:

    host.*      the machine: disk, inodes, memory pressure, load, clock
    runtime.*   workerd: restarts, crash loops, a pin that moved
    tenant.*    one tenant: a quota it crossed
    front.*     the front door: rate limiting, slowloris
    adapter.*   a store: unreachable, degraded, a partial read
    cache.*     the cache: thrashing
    cert.*      TLS: expiring, renewal failed
    egress.*    the egress policy: denials spiking, live rules drifted
    secrets.*   the secret store: sealed, a rotation overdue
    backup.*    backups: stale, verify failed, drill failed
    audit.*     the audit chain: broken
    vm.*        a microVM: boot failed, hypervisor unreachable
    isolation.* the mode: a mechanism that used to be there is not

`diagnose` prints what bastion already did, not only what happened. An operator arriving at a
broken box needs that second half more: knowing a tenant was restarted twice and then quarantined
is the difference between diagnosing the fault and diagnosing the repair.

### Optional Bindings

Separately from findings, this reports which optional binding software is installed:

    bastion capability list

Images and Browser need software this host does not ship. The command prints what each one needs,
roughly what it costs on disk, and the exact install command for this machine's package manager.
To run that command through bastion instead of by hand:

    bastion capability install images
    bastion capability install browser

That is privileged and never implicit: nothing installs software because a site asked for it. In
the dashboard the same thing is a button on the overview page, visible to an operator only.

Findings carry five severities. `debug` is off by default and switchable per tenant and per
site. `info` is recorded only. `warn` is recorded and alerted, and is only ever observed
automatically. `error` gets the three bounded rungs. `critical` adds quarantine after three
strikes and rollback after a thirty minute dwell.

Per-request logging is `debug` rather than `info`, and the reason is measured: an earlier
observability setup wrote every request into one unpruned file, reached 20.75 GB, and decayed the
throughput ceiling from 871 to 600 requests per second with nothing reporting it.

## Repairing

<a id="repairing"></a>

The repair ladder has six rungs: observe, reset, reconstruct, reconfigure,
quarantine and rollback. Each has a class that decides whether it may run unattended.

    bastion repair <code>
    bastion repair <code> --rung reset
    bastion quarantine list
    bastion quarantine clear acme

Two refusals are the point. The rebuild class is held back while the host is shedding load,
because spending the resource a host is already short of is how a repair becomes the outage. And
`--auto` covers the safe and rebuild classes only, so nothing stateful runs unattended.

Every automatic repair records what it did and how to undo it. Break-glass matters more than the
automation: a repair nobody can reverse is a repair nobody should have run.

## Observing

<a id="observing"></a>

bastion exposes Prometheus on the management listener, writes structured logs to
disk, and renders its health tree locally so a box with the network down is still diagnosable.

    bastion metrics
    bastion logs --tenant acme --since 10m
    bastion tail

Every series carries a node label and, where it means anything, tenant and site labels. Requests,
CPU, storage bytes and rows written are the inputs a billing rollup needs, and adding the label
now costs one line where adding it later is a migration across every series already recorded.

In a cluster, logs stay on the node that wrote them and are readable three ways: the files under
the state directory, `bastion logs` on that node, and `bastion logs --node all` from the
control node, which proxies and names any node it could not reach. The dashboard is never the only
export path, because a box whose dashboard is broken is exactly the box whose logs someone needs.

## Capacity

<a id="capacity"></a>

`bastion capacity` reads this host and says what it holds. It prints a recommended
count, a maximum, the term that binds, and the provenance of every input.

    bastion capacity
    bastion capacity --what-if 200

Provenance is probed, stated or assumed, and the answer carries the weakest of its inputs. A
capacity figure presented as measured when one input was assumed is the failure the column exists
to prevent.

Residency decides which term binds. Under `evict` a site is dropped after ten seconds idle, so
RAM bounds how many sites may be resident at once and disk bounds how many may exist; the answer
reports those separately. Under `pin` every site is resident forever and RAM bounds the count
directly.

Pinning deletes the cold boot and inverts the cost rather than removing it. Each resident site
holds its memory permanently and nothing reclaims it, because linear memory has no shrink
operation. A `pin` configuration whose worst case exceeds the tenant's memory limit is refused
at validation time with both numbers named.

This figure describes this host. It is not a sites-per-server density and must not be quoted as
one.

## Backups

<a id="backups"></a>

    bastion backup now
    bastion backup verify www.example.edu
    bastion backup drill
    bastion backup restore www.example.edu --to scratch

A live Durable Object database cannot be copied byte for byte. workerd writes the database
alongside a write-ahead log, and the log holds committed pages the file does not, so a plain copy
is corrupt with nothing reporting it. bastion captures with VACUUM INTO where the database is
reachable, the SQLite online backup API where it is not, and a quiesced copy as the fallback. The
method used is recorded with the backup.

Storage is content addressed at a fixed 16 KiB frame, so a second backup costs its changed bytes
rather than its size. Encryption is on and a backup refuses to run without a key, because the
whole point of an off-host target is that the bytes leave the box carrying every site's database.

A backup nobody has restored is not a backup. `backup drill` restores the newest one into a
scratch tenant, boots it, runs the site's probe and compares a rendered page. It is scheduled by
default, and a drill that has never run is a warning rather than silence.

## Secrets

<a id="secrets"></a>

Secrets never live in bastion.yml. Four drivers sit behind one contract: the OS
keyring, the environment, an encrypted file, and a KMS.

    bastion secrets set smtp-password
    bastion secrets list
    bastion secrets rotate smtp-password

`list` returns names and never values. That asymmetry is the mechanism rather than a convention:
a settings form, a JSON payload and an audit line all call `list`, and none of them can carry a
secret because the method they have cannot produce one.

The KMS driver is a structural client contract, so AWS KMS, GCP KMS, Vault and Azure Key Vault all
satisfy it without bastion depending on any of them. bastion stores only ciphertext, so a stolen
disk is a set of blobs that need a call to someone else's service to open.

The encrypted file driver is sealed until it is given a passphrase. Reads raise a typed error
naming the seal rather than answering empty.

## TLS

<a id="tls"></a>

workerd cannot do SNI. Its TLS options carry exactly one keypair, so one certificate
per socket cannot serve a multi-hostname box. bastion terminates TLS itself and workerd sits behind
it on plain HTTP over a unix socket.

    bastion cert plan www.example.edu
    bastion cert list

`cert plan` says which path a name would take and why, without asking a CA for anything. There
are six, and which one you get depends on what can actually work rather than on a preference:

    imported             an operator installed a chain, and bastion never replaces it
    acme-http-01         the name resolves here and the front door answers the challenge
    acme-dns-01          a DNS provider hosts the zone, so no HTTP has to reach this node
    acme-dns-01-manual   the same, with you publishing the TXT record by hand
    local-ca             a local name, signed by a CA you generated off this host
    self-signed          a local name with no CA at all

Nothing about this requires Cloudflare or any other third party. HTTP-01 needs only that the name
points here. An institutional CA needs no DNS integration at all.

For a CA you run yourself, export a signing request, have it signed, and import the result:

    bastion cert import www.example.edu ./fullchain.pem --key ./privkey.pem

An import is checked before it is installed. The private key must match the leaf, the chain must be
ordered leaf first and each certificate signed by the next, the names must cover what the site
serves, and it must not have expired. Each of those fails somewhere unhelpful otherwise: a
mismatched key is a handshake error with nothing in this side's log, and a chain missing its
intermediate works in a browser that has already cached it and fails for everyone else.

An imported chain is never renewed automatically. Replacing an institution's own certificate with
one from a public CA is not a decision bastion makes quietly, so it warns as the expiry approaches
and waits for you.

A wildcard needs DNS-01, which needs either a provider or a manual record. One wildcard covers
every allocated subdomain and removes per-site issuance entirely, at the cost of one key covering
every site on the box. That is a judgement about blast radius rather than a default.

For a lab or a name no public CA will issue for:

    bastion cert self-sign site.local

That certificate is signed by nobody and lasts 90 days on purpose. A self-signed certificate with a
long life is one nobody replaces. Where `mkcert` is on PATH it is used instead, so a developer who
already trusts its CA is not asked to trust a second one.

The local CA's private key never lives on a bastion host. Installing a CA into a trust store does
not need the CA key, and a CA key on a multi-tenant box is an interception capability against every
client that trusted it. `bastion cert trust` installs the public certificate and refuses a file
that carries a key.

Renewal follows the expiry ladder: warn at 21 days, error at 7, critical at 2. The expiry is read
from the certificate rather than assumed, because an institutional CA commonly issues for a year
and a loop hard-coded to ninety days would renew eleven months early against a rate limit.

A certificate change rebinds the listener rather than reloading it. Measured on Bun 1.4.0:
`server.reload()` does not re-read the TLS table, while `reusePort` lets the replacement bind
before the old listener drains, so there is no window where nothing is bound.

## Egress

<a id="egress"></a>

A Worker's outbound fetch leaves from the operator's LAN, so the default posture on
a self-hosted box is request forgery into the internal network.

    bastion egress show --tenant acme
    bastion egress allow acme smtp.example.edu:587
    bastion egress test acme 169.254.169.254:80

Egress is denied in two layers because one is not enough. The generated configuration points the
global outbound at a per-tenant proxy, and a network namespace that cannot route to the LAN is the
layer that survives a workerd bug.

Four ranges are dropped before any allow rule is consulted: loopback, link-local, and the private
IPv4 and IPv6 ranges. Cloud metadata at 169.254.169.254 hands out instance credentials, loopback
reaches the management listener, and the private ranges are every other tenant's admin port and
the hypervisor's management interface.

Rules live in bastion's own nftables table so it never edits the operator's. A rule someone added
by hand is reported as drift rather than reverted, because silently undoing a firewall change is
how a security tool gets switched off.

## Isolation

<a id="isolation"></a>

Three modes, each one workerd process per tenant, differing in the wall around that
process.

    solo      the host, plus cgroups v2 for cpu, memory and pids
    hardened  plus a network namespace, a syscall filter and an AppArmor profile
    isolated  plus one microVM per tenant

Only `isolated` is multi-tenant safe. workerd's own README states the requirement: it does not
contain defence in depth against implementation bugs, and code that may be malicious must run
inside a virtual machine or equivalent.

The threat is current rather than theoretical. Cloudflare published a working Spectre read against
co-located Workers in production at roughly 12 bits per second and 99% accuracy, using a
high-resolution clock fetched over a WebSocket, which voids the frozen-timer defence. The
co-location that attack works to achieve is free on a shared-process self-hosted box.

    bastion vm list
    bastion vm stop acme

Guests get no network interface at all; adapter traffic crosses on vsock, so the guest opens no
socket bastion did not give it. The jailer chroot is created fresh at 0700 per boot, and
`--enable-pci` is never constructed, which closes CVE-2026-5747 by argument rather than by
staying patched.

A mechanism that used to be present and now is not never downgrades the mode. bastion refuses and
names what disappeared.

## Clustering

<a id="clustering"></a>

workerd has no clustering: objects are always local to one instance of the runtime.
bastion supplies the cluster itself.

    bastion cluster init
    bastion cluster join --control 10.0.0.1:8788 --token <token>
    bastion cluster provision 10.0.1.0/24
    bastion cluster place www.example.edu --replicas 1

Children dial out to the control node and it never dials in, so a child behind NAT needs no
inbound rule.

Each site has one primary node holding the authoritative object, plus zero or more replica nodes.
Writes and anything off the serving path go to the primary. Reads on the serving path are served
from a local replica when this node holds one. Inside a node the site's own lane routing is
unchanged.

Two failure modes are designed out rather than discovered. Every node forwards a byte-identical
Host header, because Drupal derives its session cookie name from the host and a node forwarding a
different one renders every visitor anonymous. And a node join renders a form-bearing page and
verifies the private key exists first, because that key is minted lazily and a freshly migrated
site without one refuses every replica for a reason that reads like a capacity limit.

Promotion is not free. Making a replica authoritative loses anything not yet replicated, bounded
by the replication lag. `cluster promote` prints the worst-case window before it acts.

`cluster provision` installs children over SSH. A range is dry-run by default, a range wider
than a /24 refuses without an explicit flag and says how many addresses it expands to, and a host
that answers but already has a bastion state directory is skipped by name rather than
overwritten.

## Access

<a id="access"></a>

bastion has three infrastructure roles and models no content permissions. The CMS
already has roles; rebuilding them above it would be an abstraction drawn against one
implementation.

    operator       the box and the cluster; the only role that touches the host
    tenant-admin   one tenant: sites within quota, deploys, rollbacks, logs and meters
    tenant-viewer  one tenant, read only

    bastion access invite acme --role tenant-admin
    bastion api token create --tenant students --role tenant-admin

Below those is the site's own owner token, which bastion mints at claim and hands over once. From
there the site is the CMS's business, and drangler works against it unchanged.

Authorization derives the tenant from the session or the token, never from a path, a query or a
body parameter. No route accepts a tenant name from the client.

Quota is what makes delegation safe. A tenant-admin cannot exhaust the box because `maxSites`
and the tenant's cgroup bound them, so handing a department self-service costs the operator
nothing to watch.

## Auditing

<a id="auditing"></a>

    bastion audit tail
    bastion audit verify
    bastion audit export --ndjson

The log is append-only and hash-chained: each line carries the hash of the one before it, so an
edit or a deletion breaks every hash after it and `audit verify` names where. The chain is
carried across a rotation, because a chain that restarts at every rotation is one an attacker only
has to rotate.

Three profiles. `minimal` records security-relevant events only. `balanced` is the default.
`everything` records all of it and needs its retention policy read first.

Retention ships with the writer rather than after it. Rotation, a byte budget and an age budget
apply to both the audit log and the runtime logs.

In a cluster each node chains its own log, because one chain across nodes needs consensus that
bastion does not have. The control node keeps a registry of chain heads, so a child rewriting its
own history is detectable from outside it, and `audit verify --cluster` compares them.

## Adapters

<a id="adapters"></a>

workerd ships the bindings and no stores. bastion supplies the stores.

    bastion cache stats
    bastion kv list
    bastion r2 list

The cache adapter decides throughput and is not one driver among several. The edge tier absorbs
82% of anonymous traffic before it reaches the Durable Object; with an always-miss stub in its
place, all of it arrives. That is roughly a fivefold swing, so `driver: null` is refused outside
the test lane, the disk driver carries a memory tier in front of it, and concurrent misses for one
key are single-flighted so a cold cache after a restart is not a herd.

Drivers, by adapter. Cache: disk or memory. KV: SQLite, memory, Redis or Valkey. Objects: disk,
S3, R2, B2, GCS in interoperability mode, Azure Blob, SFTP or FTP. SQL: SQLite, Postgres, MySQL or
MariaDB.

Redis, SFTP, FTP and the three SQL servers take a client you supply rather than a library bastion
chose for you. Each contract is structural and probes for the optional halves, because clients
spell the same commands differently.

The static assets adapter is a worker in front of a disk service, never a bare disk service. A
bare one answers everything as an octet stream, ignores the ignore list, and served a site
database publicly once.

### Bindings workerd Has No Field For

KV, R2 and Queues are real designators in workerd's schema. D1, Vectorize, Workers AI, Images,
send_email and Analytics Engine are not: there is no field for any of them. They are bound through
`wrapped`, which hands an internal module a connection to bastion's adapter socket and makes
whatever that module returns the value of the binding. The bundle calls `env.DB.prepare()` and
`env.AI.run()` unchanged.

Hyperdrive is the exception in the other direction. It IS a real group in the schema, so bastion
emits it natively and workerd does its own pooling.

What sits under each one is yours:

    drivers:
      d1:        { driver: sqlite }
      vectorize: { driver: memory, dimensions: 768 }
      ai:        { driver: openai-compatible, endpoint: http://127.0.0.1:11434/v1 }
      images:    { driver: magick }
      browser:   { driver: chromium }
      email:     { driver: smtp, host: smtp.example.edu, port: 587 }

Two of those need software this host does not ship, and bastion installs nothing on its own:

    bastion capability list
    bastion capability install images

Workers AI runs on your hardware. Cloudflare's catalogue is open-weight models, so the same
weights run on a box with a GPU, and the `openai-compatible` driver reaches ollama, vLLM,
llama.cpp's server or LM Studio without bastion depending on any of them. Offloading to
Cloudflare's own endpoint is available and opt-in, with an allow list and no automatic failover
to it.

send_email exists on Cloudflare because a Worker cannot open port 25. bastion is an ordinary
process on your host, so it dials your mail server directly, and the message is passed through
byte for byte rather than re-encoded, which is what keeps a DKIM signature verifying.

A site that binds one of these while its driver is unconfigured is refused at validation with the
install or the setting it needs, rather than accepted and failed on the first request.

## Updating

<a id="updating"></a>

    bastion update check --to v1.20260828.1
    bastion update apply --staged
    bastion update rollback

workerd is pinned by binary SHA-256 rather than by tag, because a tag is a mutable pointer at a
release someone else owns and the reason a pin exists is that the bytes are the ones that were
tested.

Two refusals guard a change. Below the CVE floor, bastion refuses and names the CVE the floor
closes; `--force-below-floor` accepts it and records which CVE was accepted in the audit log.
Across a storage format change it refuses without `--restore-from` naming a verified backup,
because a rollback across a format change is not a rollback.

`--staged` moves one tenant, health-checks it, then the rest.

The pinned workerd's V8 version is resolved from workerd's own build file rather than from the
runtime. `process.versions.v8` is the empty string inside workerd, hardcoded, so a check that
introspects the runtime is designing against something that does not exist.

## Migrating

<a id="migrating"></a>

    bastion migrate survey ssh://host.example.edu
    bastion migrate plan ssh://host.example.edu
    bastion migrate run ssh://host.example.edu --yes

Three sources: a VPS over SSH, a managed or self-managed drupflare site through its export
endpoint, and a Cloudflare account through its API.

Multi-site is the assumption. A VPS is surveyed for every site on it; asking a customer to
enumerate their own sites is where a migration stalls.

One planner produces a typed plan and both the CLI and the dashboard render it, so the two cannot
diverge. The plan lists each site, its size, whether it fits the destination's capacity, and what
will not carry. PHP extensions compiled into the origin, server-level rewrites, system cron
entries, TLS certificates and server mail configuration do not carry, and each says why.

A run checkpoints at the site boundary, so a failed tenth site does not re-move the first nine.
Dry run is the default.

Nothing is deleted at the source. bastion imports; decommissioning the origin is a separate and
deliberate act.

## Dashboard

<a id="dashboard"></a>

The dashboard is embedded in the binary and served by the management listener, which
binds to 127.0.0.1 by default. A first run prints a one-time claim token.

    bastion up
    bastion dashboard token
    bastion dashboard open

Local authentication works with no internet, which is the point: the failure mode where the
dashboard is most needed is the one where the box reaches nothing.

Every CLI action has a button. A route with no surface is a defect.

Two views behind one authorization function: the operator view reaches the box, the cluster and
every tenant; the tenant view is a filter over the same components showing one tenant's health,
logs, meters and deploy history. It is a filter rather than a second application, because a
parallel implementation is how two views drift into a privilege bug.

The session cookie uses the __Host- prefix with HttpOnly, Secure and SameSite=Lax. CSRF is a
synchronizer token, with Sec-Fetch-Site as the first gate and an Origin comparison as the
fallback; SameSite is defence in depth and does not replace it. The content security policy is
nonce based with strict-dynamic, and object-src and base-uri are both none.

A tenant's site is never served from the management origin, so a stored cross-site scripting bug
in a hosted CMS cannot reach the dashboard's cookie.

## Pairing

<a id="pairing"></a>

`bastion pair` refuses in this version and names the reason: the drupflare control
plane it would dial is not built yet.

The posture is recorded now so the later implementation has nothing to design. Pairing is outbound
only: bastion dials the control plane and the control plane never dials in, which is the same rule
the cluster already follows between a child and its control node.

## Manual

<a id="manual"></a>

    bastion manual --list
    bastion manual tls

This reference is embedded in the binary, so a box with no network still has its documentation.
The dashboard renders the same sections as a page tree.
