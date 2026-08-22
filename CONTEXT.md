# nextjs-redis-cache-handler

A Redis/Valkey-backed cache handler for Next.js Cache Components (`'use cache'`), shared by every instance of a
multi-instance deployment so that cached output and revalidation events are seen by all of them.

## Language

### Next.js side

**Cache Handler**:
The object Next.js calls to read, write and invalidate `'use cache'` output: the `CacheHandler` interface from
`cacheHandlers` (plural) in `next.config`.
_Avoid_: incremental cache handler, ISR cache handler (that is `cacheHandler`, singular, a different interface)

**Handler slot**:
The name under which a Cache Handler is registered in `cacheHandlers` and selected by a directive: `default` for
`'use cache'`, `remote` for `'use cache: remote'`, or any custom name for `'use cache: <name>'`.
_Avoid_: handler type, handler kind

**Entry**:
One cached output: its value (an RSC payload), its explicit tags, and its timings (`timestamp`, `stale`,
`revalidate`, `expire`). Identified by a cache key that Next.js computes from build id, function id and arguments.
_Avoid_: record, item, cached value

**Explicit tag**:
A tag the developer attaches to an Entry with `cacheTag()` (or `fetch`'s `next.tags`). Stored on the Entry.
_Avoid_: user tag, custom tag

**Soft tag**:
A tag Next.js derives from the route path (`_N_T_/layout`, `_N_T_/blog/layout`, `_N_T_/blog/hello`, …) so that
`revalidatePath` works through the tag system. Never stored on the Entry; handed to `get()` per request.
_Avoid_: implicit tag, path tag

**Stale**:
The state of an Entry or tag that may still be served while a fresh render is produced in the background
(stale-while-revalidate). `revalidateTag(tag, 'max')` makes a tag stale.
_Avoid_: outdated, invalid

**Expired**:
The state of an Entry or tag that must not be served; the next read is a miss and blocks on a fresh render.
`updateTag(tag)` and `revalidateTag(tag, { expire: 0 })` make a tag expired.
_Avoid_: invalidated, purged, deleted

**Prerendered route**:
A route whose whole output was produced at build time and is served from the ISR cache without consulting the
Cache Handler; its Entries are read again only when that copy is regenerated.
_Avoid_: static route, static page

**ISR cache**:
The per-instance store of prerendered output, owned by the singular `cacheHandler`, not by this library. A
revalidation only reaches the ISR cache of the instance that ran it; other instances catch up when their copy's
`revalidate` window elapses.
_Avoid_: page cache, static cache, incremental cache

### Handler side

**Tag manifest**:
The record, per tag, of when it was last made stale and when it was last made expired. The shared copy lives in
Redis; each instance keeps a local copy refreshed before every request.
_Avoid_: tag index, tag registry

**Handler clock**:
The clock every instant this handler compares is stamped on: one value per Key prefix, held in the tag slot,
never below the last stamp issued and strictly increasing at each one, so that a backward step of the Redis
host's wall clock cannot reorder an Entry and a tag event.
_Avoid_: logical clock, Lamport clock, Redis clock (that is `TIME`, the wall clock the Handler clock is floored
by)

**Write time**:
The instant, on the Handler clock, at which an Entry's generation started; the only value tag events are compared
against. Derived at write from the Entry's age, so it is independent of the app host's clock.
_Avoid_: timestamp (that is Next.js's app-clock field on the Entry, stored and returned unchanged)

**Key prefix**:
The Redis key namespace under which one app's Entries and Tag manifest live. All instances of one app share it;
two apps never do. The only isolation mechanism between apps on one Redis.
_Avoid_: namespace, database

**Zero-config entry**:
The ready-made handler module, configured from environment variables, that wraps the factory for apps that
need no custom options.
_Avoid_: default handler (that is Next.js's built-in one), preset

### Test side

**Instance**:
One `next start` process serving one build. The e2e suite runs two Instances on one store so that propagation
between them can be observed.
_Avoid_: server, node, replica

**Fixture app**:
The Next.js app under `e2e/` whose routes and cached functions exercise the Cache Handler end to end.
_Avoid_: example app, demo, sample

**Scenario**:
One sequential narrative of requests and revalidations across the two Instances, asserted on both the HTTP output
and the Recorded calls. One scenario per e2e test file, each with its own fresh Instances.
_Avoid_: test case, flow, journey

**Recorded call**:
One Cache Handler method invocation as logged by the Fixture app's recording wrapper: which Instance, which
method, with what key and tags, and its outcome.
_Avoid_: log line, trace, event

**Oracle**:
Next.js's built-in in-memory Cache Handler, used as the reference implementation in contract tests: the same
Scenario runs against it and against this handler, and the observable results are compared.
_Avoid_: reference handler, baseline, default handler (ambiguous with the `default` Handler slot)
