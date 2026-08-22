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

### Handler side

**Tag manifest**:
The record, per tag, of when it was last made stale and when it was last made expired. The shared copy lives in
Redis; each instance keeps a local copy refreshed before every request.
_Avoid_: tag index, tag registry

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
