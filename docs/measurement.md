# Measurement

What bastion has measured, what is waiting on hardware, and what is refused. Numbers here were
taken on a named machine with a named method, or they are marked as not taken.

## Taken

### `server.reload()` does not re-read the TLS table

Bun 1.4.0, macOS 25.5, 2026-09-21. Three arms, run against a live listener:

| question                                                                | answer |
| ----------------------------------------------------------------------- | ------ |
| Does `server.reload()` re-read `tls`?                                   | no     |
| Does the `tls: [{...}]` SNI array work when the server is born with it? | yes    |
| Can two listeners hold one port under `reusePort: true`?                | yes    |

The second arm is the control. Without it, the first result is indistinguishable from SNI not
working at all, and the wrong conclusion would have been that bastion cannot terminate multiple
hostnames in one process.

The consequence is in the shipped code: a certificate renewal or a new tenant hostname rebinds the
listener rather than calling `reload()`, and `reusePort` means the replacement binds before the old
one drains, so nothing is unbound in between.

### `node:sqlite` resolves under bun 1.4.0

Contradicts a sibling memory recorded against an older bun. One SQLite implementation therefore
serves the gate lane, a node install and the compiled binary, and `bun:sqlite` is used nowhere.

### `isolated` boots a guest

paisley-park, Ubuntu 24.04, kernel 6.8.0, Ryzen 9 9900X on bare metal, 2026-09-22. Firecracker
1.17.0 through the jailer, guest kernel 6.1.128, load average 0.56 to 0.60 across the run.

`bastion`'s own `firecrackerHypervisor().create()` places the guest's files, starts the jailer and
writes the console. The guest reaches userspace and powers itself off. `REQUIRE_KVM=1` runs it, and
`core/scripts/microvm-rig.sh` builds the hypervisor, kernel and root filesystem it needs.

| reading                                     | value                                  |
| ------------------------------------------- | -------------------------------------- |
| guest kernel to userspace                   | about 0.6 s of guest time              |
| `create()` to the guest powering itself off | 1.65 s wall, median of 5, spread 18 ms |

The wall figure includes `docker exec` and the jailer's chroot setup, so it bounds a tenant's cold
start rather than measuring it. Memory per guest against the per-tenant-process baseline is still
open, and stays in the table below.

The first boot found three defects, each of which made every guest die on startup and none of which
the unit lane could see. The chroot was computed without the path component the jailer inserts, and
without following the symlink the jailer resolves, so bastion wrote the guest's configuration to a
directory nothing read. Nothing placed the kernel or the root filesystem inside the chroot, so
firecracker chrooted and then opened a path that no longer named anything. The serial console was
discarded, so a guest that failed to boot reported the failure nowhere.

That is the shape this project already pays for elsewhere: argv and refusals scored green while the
thing they described had never run once.

## Inherited, and not re-run

`J/request` and `J/render` are measured for both runtimes on one RAPL counter and **are at
parity** within about 13%, on the cached tier and on a full render. That result already exists and
this project does not re-take it.

The conclusion matters more than the number, and bastion's documentation inherits it: drupflare's
energy advantage is not per-request efficiency. It is the idle term and the render fraction.
Anything in bastion's own documentation that reads as a per-request efficiency claim is wrong.

One topology fact goes with it. Cloudflare's render fraction sums per path per colo; one box has
one cache. **bastion's render fraction is structurally lower for identical traffic**, so a
comparison that does not say so reads a topology difference as a runtime win.

## Waiting on hardware

Each of these needs a Linux host with the named mechanism. None of them is in CI.

| measurement                                                                                   | needs                                         | why it cannot be inferred                                                                                          |
| --------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| the release payload runs unmodified under bastion's generated capnp, with `unsafeEval: false` | a workerd binary and the published payload    | the two claims are only jointly meaningful, and the raw compiled-module seam is an inference until a boot reads it |
| Durable Object persistence under power loss                                                   | a host that can be hard-killed                | `localDisk` is the one storage path nobody has pulled the plug on                                                  |
| `residency: pin` against `evict`                                                              | a host with enough RAM to hold the pinned set | one flag separates them, so the cost is priced rather than assumed                                                 |
| memory per tenant under `isolated`                                                            | `/dev/kvm` and several tenants at once        | a guest boots, but what one costs against the per-tenant-process baseline is unread                                |
| the per-site resident cost on real hardware                                                   | any Linux host running sites                  | it is the term the capacity model currently carries as `assumed`                                                   |

The memory row is what now bounds a capacity answer for `isolated`. A guest boots and the mode
works; what a rack of them costs is a different reading, and the capacity model carries it as
`assumed` until a host takes it.

The per-site cost row is the one that improves the product rather than a document. Every capacity answer
carries the weakest provenance of its inputs, so until a host measures its own per-site cost, every
answer reads `assumed`. One measurement moves them all to `probed`.

## Refused

**A sites-per-server density figure.** The roadmap refuses it and the refusal binds here. It would
rest on a memory reading taken against a binary the project no longer ships, and it assumes every
tenant is simultaneously resident, which is the thing eviction exists to prevent.

`bastion capacity` reports what a given host holds from that host's own readings, which is a
different and permitted claim. The command says so in its own output.

**A throughput comparison taken with the cache tier off.** The edge tier absorbs 82% of anonymous
traffic before the Durable Object. An interleaved probe reading drupflare at 0.37 to 0.41 times a
VPS, against a standalone probe of the same arm reading 216 requests per second where the
interleaved one read 91, is an instrument disagreement rather than a result.

The likely cause is in that rig's own configuration: `cacheApiOutbound` points at an always-miss
stub, so the drupflare arm runs with the tier that absorbs most of its traffic disabled while the
VPS arm's nginx cache is on. Re-running against the stub would produce a second number for a
configuration nobody ships. The fix is a real cache adapter, which now exists.

## The mechanism that was closed, and the objective that was not

**`zstd -D` delta against the previous version is not reachable** from the runtime bastion ships
on: node's zlib exposes zstd's compression parameters and not its dictionary API.

The objective that mechanism was for, a new backup version costing only its changed bytes, is met
by content-addressed framing instead. An unchanged 16 KiB region hashes to a digest the store
already holds and is not written again. Measured in the gate lane: a second backup of an eight-frame
database with one changed frame writes one frame and reuses seven.

That dedups across versions the way a delta would, and additionally across sites, which a
per-version dictionary could not. Revisit if node exposes `ZSTD_CCtx_loadDictionary`; the fixed
framing is already the input a dictionary delta would want.

**A `scheduled()` handler is not reachable** from a plane driving `workerd serve`. `workerd.capnp`
carries no cron, schedule or trigger field anywhere in the schema, and `server.c++` serves no path
that reaches `runScheduled`, which is a C++ method on `WorkerInterface` with no configuration
surface. Miniflare's `/cdn-cgi/handler/scheduled` is injected by a wrapper worker miniflare writes
itself, not by workerd. A `service` binding yields a Fetcher, which exposes `fetch()` and not
`scheduled()`, so the wrapped-module mechanism that carries D1, Vectorize and Workers AI does not
reach this one either.

The objective, periodic work on a self-hosted node, is met by a Durable Object alarm, which workerd
does run and which the smoke lane already exercised across a 75-chunk replay. `workforce`'s
`workerd` plane declares `schedules: cannot(...)` naming the runtime limit rather than the product,
and `site add --template` prints the cron expressions a manifest declares rather than accepting
them silently. Revisit only if workerd grows a trigger in its own schema.
