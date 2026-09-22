# The 2026-09-21 smoke lane

The measured `workerd serve` configuration that answered the v1.0.2 gate, recovered from the
`worker` session's scratchpad. `config2.capnp` is the later one and carries the KV stub.

These are fixtures, not templates. `capnp/generate.ts` reproduces this shape from declarative
state, and `tests/unit/capnp/smoke-parity.spec.ts` compares the two so a change to the generator
that drifts from the measured configuration fails rather than silently producing a config nobody
has booted.

`nullcache.js` records the cache-over-HTTP protocol workerd expects: `GET` answers 504 on a miss,
`PUT` answers 204, `PURGE` answers 404. `kvstub.js` records the KV shape: the key is the decoded
pathname, `GET`/`PUT`/`DELETE`.
