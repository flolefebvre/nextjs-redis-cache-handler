# @flefebvre/nextjs-redis-cache-handler

A Redis/Valkey-backed cache handler for Next.js Cache Components (`'use cache'`), so that every Instance of a
multi-instance deployment shares the same cached output and sees the same revalidation events.

## What it is

A Next.js app using Cache Components (`'use cache'`) and deployed as several Instances behind a load balancer has
no shared cache: the built-in Cache Handler keeps Entries and its Tag manifest in the memory of each process. The
same cached output is regenerated once per Instance, and `updateTag()`, `revalidateTag()` and `revalidatePath()`
run on one Instance never reach the others, which keep serving output the app has just declared Stale or Expired.
This package moves that layer into the Redis or Valkey you already run: every Instance of one app shares one Key
prefix, so an Entry written by one Instance is read by all, and a tag event written by one Instance is seen by
all on their next request.

When the store is slow or down, reads miss and writes are dropped within a bounded timeout, so the app gets
slower, never stale, never a 500 — with one deliberate exception, an invalidation that could not be persisted.
See [Failure behaviour](#failure-behaviour).

This is the **plural** `cacheHandlers` config — Next.js 16.3 Cache Components, `'use cache'`. The **singular**
`cacheHandler` (prerendered pages / ISR, `fetch()` caching, `unstable_cache()`) is a different interface that
this library does not implement; see [What propagates between instances](#what-propagates-between-instances).

**Requirements:** Next.js ≥ 16.3 with `cacheComponents` enabled, Node.js ≥ 22.12, Redis ≥ 6.2 or Valkey ≥ 7.2.
The package is ESM only and ships its own types; `next` is a peer dependency and is never imported at runtime.

## Install and configure

```bash
npm install @flefebvre/nextjs-redis-cache-handler
# pnpm add @flefebvre/nextjs-redis-cache-handler
```

Point the `default` Handler slot at the Zero-config entry — the ready-made handler module this package ships,
configured from environment variables — and set `REDIS_URL`. `cacheHandlers` takes a **path**, not a module, so
`handlerPath` (the absolute path of that module, resolved at import time) is what you hand it.

`next.config.ts`:

```ts
import { handlerPath } from "@flefebvre/nextjs-redis-cache-handler";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  cacheHandlers: {
    default: handlerPath,
  },
};

export default nextConfig;
```

`next.config.mjs` (and an ESM `next.config.js`):

```js
import { handlerPath } from "@flefebvre/nextjs-redis-cache-handler";

export default {
  cacheComponents: true,
  cacheHandlers: {
    default: handlerPath,
  },
};
```

A CommonJS `next.config.js` cannot `import`, so it names the same module by specifier, the way the Next.js docs
show:

```js
module.exports = {
  cacheComponents: true,
  cacheHandlers: {
    default: require.resolve("@flefebvre/nextjs-redis-cache-handler/handler"),
  },
};
```

To back `'use cache: remote'` with the same store, give the `remote` slot the same path:

```ts
cacheHandlers: {
  default: handlerPath,
  remote: handlerPath,
},
```

Then set the connection URL, wherever your app's environment is configured:

```bash
REDIS_URL=redis://localhost:6379
```

That is the whole setup. Every other environment variable is optional; see the
[environment variable reference](#environment-variable-reference).

**No `REDIS_URL`, no failure.** A process that has none — a CI box building without a store, most of all — gets a
handler that caches nothing: every read is a miss, every write is dropped, and one `console.error` says so, once.
`next build` never depends on cache availability. A build that _does_ reach the store writes the Entries its
prerender produced, so the first runtime render on each Instance is a hit.

**Edge routes still build.** An app with an Edge-bundled route (Pages Router `experimental-edge`) compiles on
webpack and on Turbopack alike: both entry points resolve to an Edge target that imports no Redis client and no
`node:` module. The `'use cache'` scopes of such a route render uncached and say so once; the Node.js side of the
app is unaffected.

`@flefebvre/nextjs-redis-cache-handler/handler-target` also appears in the package's `exports`. It is internal —
the self-reference the Zero-config entry uses to reach the target its runtime can run — and nothing should ever
register it.

## The factory

Register your own module instead when you need something no environment variable covers: a client of your own,
an `onEvent` or an `onError` hook.

```ts
// cache-handler.ts
import { createRedisCacheHandler } from "@flefebvre/nextjs-redis-cache-handler";

export default createRedisCacheHandler({
  url: process.env.REDIS_URL,
  keyPrefix: "my-app:",
  onEvent: (event) => metrics.increment(event.type),
  onError: (error, op) => logger.error({ error, op }, "cache handler"),
});
```

`cacheHandlers` still takes a path, so hand it the path of that module — `require.resolve('./cache-handler.js')`
from a CommonJS config, `fileURLToPath(import.meta.resolve('./cache-handler.js'))` from an ESM one.

To keep the environment's configuration and add hooks, spread `optionsFromEnv`, which reads the same variables
the Zero-config entry does:

```ts
import { createRedisCacheHandler, optionsFromEnv } from "@flefebvre/nextjs-redis-cache-handler";

export default createRedisCacheHandler({ ...optionsFromEnv(process.env), onEvent });
```

`optionsFromEnv` returns `undefined` when the environment configures no store at all, and it is then for your app
to decide whether that is a startup failure or a handler that caches nothing.

### Options

Exactly one of `url` and `client` is required; every other option has a default. Every value is checked when the
factory is called — a bad value, an unknown key, or both or neither of `url` and `client` throws synchronously,
naming the option — so a misconfiguration is a startup failure rather than a cache that quietly serves nothing.

| Option              | Type                  | Default                               | Meaning                                                                                                                                                                                       |
| ------------------- | --------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`               | string                | —                                     | `redis://` or `rediss://` connection URL. The handler creates the client, tunes it, and quits it on `close()`. Exclusive with `client`                                                        |
| `client`            | node-redis client     | —                                     | A client you created and own — standalone, `createSentinel` or `createCluster`. Used exactly as given: never connected, never quit. See [Redis and Valkey support](#redis-and-valkey-support) |
| `keyPrefix`         | string, non-empty     | `next-cache:`                         | The Key prefix, used verbatim. Two apps on one server must never share it                                                                                                                     |
| `operationTimeout`  | positive integer, ms  | `1000`                                | Deadline on every awaited `get`, `set`, `getExpiration` and `refreshTags`                                                                                                                     |
| `updateTagsTimeout` | positive integer, ms  | `5000`                                | Total budget `updateTags` retries within before it throws                                                                                                                                     |
| `maxTtl`            | positive integer, s   | `2592000` (30 days)                   | Caps every Entry's TTL. The "never expire" sentinel Next.js sends always clamps to it                                                                                                         |
| `maxEntrySize`      | positive integer, B   | `1048576` (1 MiB)                     | Cap on one Entry's buffered value. A larger Entry is skipped and the scope renders uncached                                                                                                   |
| `onEvent`           | `(event) => void`     | none                                  | Called once per `get` and per `set` outcome                                                                                                                                                   |
| `onError`           | `(error, op) => void` | `console.error`, unless `debug` is on | Called once per failure, with the operation it happened in                                                                                                                                    |
| `debug`             | boolean               | `false`                               | Logs every event and every failure to the console, one line each, stamped with the Next.js phase. Coexists with the hooks: both run                                                           |

The factory returns the object `cacheHandlers` expects, plus `close()`. It opens no connection until the first
operation, scans and deletes nothing at startup, and installs no process signal handler.

### Events

`onEvent` receives one object per read and per write, discriminated on `type`, always carrying the cache `key`
and `durationMs`:

| `type`  | Carries                                                        | Meaning                                                             |
| ------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `hit`   | —                                                              | An Entry was served, fresh                                          |
| `stale` | —                                                              | An Entry was served for the wrapper to regenerate in the background |
| `miss`  | `reason`: `absent`, `expired`, `timeout`, `unavailable`        | Nothing was served, and why                                         |
| `set`   | —                                                              | An Entry was written to the store                                   |
| `skip`  | `reason`: `too-large`, `expire-zero`, `too-old`; `size`, bytes | An Entry was not written, why, and the size of the value dropped    |

`onError` receives the failure and the operation it happened in: `get`, `set`, `getExpiration`, `updateTags`,
`refreshTags`, or `connect` for every failure outside an operation. `updateTags` reports once per call, on the
failure its retries ended with, never once per attempt. Exceptions thrown by either hook are caught and ignored,
so a bug in your logging never breaks a cache read.

### An injected client stays yours

A client passed as `client` is used exactly as you handed it over: the handler never connects it, never quits it,
and `close()` leaves it open. Connecting and tuning it is your call — which is what makes it the escape hatch for
TLS material, a Sentinel or a Cluster deployment, a RESP version or a reconnect strategy this library's own
options cannot express.

### `close()`

`close()` quits a client the handler created and does nothing to an injected one. You rarely need it: under
`next start` the HTTP server keeps the process alive and Next.js drains and exits on its own.

**In a standalone script** — a warm-up, a one-off probe — it matters. The client the handler creates from `url`
is `unref()`'d once connected, so it never keeps the process alive by itself: await every operation and call
`close()` before the script ends, or the process can exit with a command still in flight.

## What propagates between instances

This handler shares `'use cache'` output and revalidation events across every instance of your app. Next.js has a
second, separate cache for prerendered pages (ISR), which this library does not touch. What that means in
practice:

| What                                                                                        | After `updateTag` / `revalidateTag` / `revalidatePath` on one instance, the other instances…                                                                                                                            |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'use cache'` output read at request time (dynamic routes, the dynamic part of a PPR route) | see the change on their next request                                                                                                                                                                                    |
| A prerendered page (`○` in the build summary), including the static shell of a PPR route    | keep serving their own copy until its `revalidate` window passes (the smallest `cacheLife` `revalidate` of the cached functions it uses; 15 minutes with the default profile), then regenerate it from the shared cache |
| `fetch()` cache, `unstable_cache()`, Route Handler responses, `next/image`                  | not handled by this library                                                                                                                                                                                             |

Prerendered pages are stored per instance by Next.js's `cacheHandler` (singular), a different interface from
`cacheHandlers`. If you need a prerendered page to update on every instance immediately, follow the
[Next.js self-hosting guide](https://nextjs.org/docs/app/guides/self-hosting#configuring-caching) on configuring
a shared `cacheHandler`; this library does not provide one.

Each row is observed on two Instances of one build, not promised: after `updateTag` on Instance A, the
prerendered route on Instance B keeps the copy it was prerendered with — the handler is not consulted for the
scopes that copy rendered, expired tag or not — while a dynamic route on B is fresh at once, and a PPR route on B
serves its ISR shell beside a fresh hole. Draft Mode is the one request kind that bypasses the Entries entirely:
Next.js re-renders every cached scope and writes none of them, and the same request without the bypass cookie is
served from the Entries again. Both are recorded, with the Scenario that observes each, in
[`docs/nextjs-caching.md`](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/docs/nextjs-caching.md).

## Failure behaviour

A store that is slow, unreachable or stalled makes the app slower. It never makes it wrong, and — with one
exception — never makes it fail.

| Operation     | On failure or past `operationTimeout`                                              | Why                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `get`         | A miss: `timeout` past the deadline, `unavailable` for anything else. Never throws | An exception from `get` is a render error, not a miss: the page would fail instead of rendering uncached   |
| `set`         | The write is dropped, reported through `onError`                                   | Next.js awaits pending writes after a Server Action, so a rejected `set` would fail the action over a blip |
| `refreshTags` | The last known Tag manifest is kept, reported through `onError`. Never throws      | A rejection fails every cache read of that request                                                         |
| `updateTags`  | Retried with exponential backoff inside `updateTagsTimeout`, then **throws**       | A swallowed invalidation would leave every Instance serving output the mutation replaced                   |

An invalidation the handler gave up on fails the Server Action that ran it: the request answers 500 and the
Instance logs the error once. That is the one deliberate failure — loud beats silently stale. A reply error no
retry can fix (`WRONGTYPE` on a corrupted Tag manifest key, `NOPERM` from an ACL) throws at once instead of
spending the budget first.

Until one full read of the Tag manifest has succeeded in a process, **every `get` is a miss** (`unavailable`);
writes still happen. A miss is slow, and serving an Entry a mutation has already dropped is wrong.

The client reconnects forever with a capped, jittered backoff, and the offline queue is off, so a command issued
while it is disconnected fails immediately and becomes a miss or a drop rather than queueing. After a
reconnection the whole Tag manifest is read again, so no tag event written during the outage is missed and an
outage ends without a restart. The tuning of a client the handler creates is fixed and not an option: 2 s connect
timeout, 15 s idle socket timeout, a `PING` every 10 s.

An Entry whose buffered value is larger than `maxEntrySize` is not stored: the scope renders uncached and a
`skip` event carries the size, so one huge cached data function cannot degrade the store for everyone.

## Redis and Valkey support

**Redis ≥ 6.2, Valkey ≥ 7.2** (any Valkey 8.x included). The handler uses a portable command set only, exercised
on both floors and on the latest release of each in CI.

**Cluster and Sentinel: inject your own client.** There is no option for a topology; you build the client and
hand it to the factory as `client`. The Tag manifest, its log and the Handler clock share one Cluster slot
through the hash tag in their names, and every Entry is routed by its own key, so no operation is ever
cross-slot.

```ts
import { createSentinel } from "redis";

const client = createSentinel({
  name: "mymaster",
  sentinelRootNodes: [{ host: "sentinel-1", port: 26379 }],
  passthroughClientErrorEvents: true,
});
await client.connect();

export default createRedisCacheHandler({ client });
```

```ts
import { createCluster } from "redis";

const client = createCluster({
  rootNodes: [{ url: "redis://node-1:6379" }, { url: "redis://node-2:6379" }],
});
await client.connect();

export default createRedisCacheHandler({ client });
```

Two caveats come with an injected client:

- **Leave replica reads off** — `replicaPoolSize` on a Sentinel, `useReplicas` on a Cluster. An Entry is read
  with a read-only command, which such a client routes to a replica, so a read lags replication: a `get` right
  after a `set` misses and the scope is rendered again. It is never a hit on an Entry a mutation replaced — the
  Tag manifest is always read from the master, and an Entry is judged by its Write time against it.
- **On Sentinel, a rebuilt connection is counted through `topology-change`.** The handler reads the whole Tag
  manifest again when the connection under it was rebuilt, because the server behind it may be a different one. A
  standalone client names that moment `reconnecting` and a Cluster client `node-reconnecting`; a Sentinel client
  names it not at all, so a failover is counted through `topology-change` instead. A connection rebuilt to the
  same master is therefore not counted and needs no full read. What is left uncounted is a master that comes back
  with a different dataset without a failover, where the handler keeps the manifest it had: it then
  over-invalidates and never under-invalidates.

One more thing to know about Sentinel: node-redis's `RedisSentinel` forwards only `error` and `topology-change`,
so a node's failure reaches `onError(…, 'connect')` **only** when the client was built with
`passthroughClientErrorEvents: true` — without it, an operator on Sentinel sees a node outage through the
operation failures alone. A Cluster client reports its nodes' failures as `connect` out of the box.

## Operations

One app's keys, all under its Key prefix:

| Key                    | Holds                                     | TTL                   |
| ---------------------- | ----------------------------------------- | --------------------- |
| `<prefix>entry:<key>`  | One Entry, Next.js's cache key stored raw | `min(expire, maxTtl)` |
| `<prefix>{tags}`       | The Tag manifest                          | none                  |
| `<prefix>{tags}:log`   | The Tag manifest's event log              | none                  |
| `<prefix>{tags}:clock` | The Handler clock                         | none                  |

**Eviction policy.** Entries carry a TTL and the three tag-slot keys carry none, so run the store that holds
them with `maxmemory-policy noeviction` or a `volatile-*` policy — `volatile-lru` or `volatile-ttl`, with
`maxmemory` sized for the Entry set, is the intended deployment: Redis then evicts Entries only and never touches
the tag slot. An `allkeys-*` policy is unsafe, because it can evict the Tag manifest, and a lost manifest is lost
invalidations: a lost log alone is detected and triggers a full read, a lost hash is not recoverable. Losing the
clock key while the host's wall clock sits behind the clock's floor also leaves a window, bounded by that step,
in which a tag event can fail to beat an Entry stamped before the loss.

**Never `FLUSHDB` under a live app**, for the same reason.

Entries disappear by themselves once past their `expire` (capped by `maxTtl`), so old builds do not accumulate.
Nothing is deleted at startup or on a new build: a rolling deploy never wipes the Entries the Instances still
running the old build are serving. Two apps on one server are isolated by their Key prefix alone — Redis
databases are never used, since Cluster has none.

## Clock skew

The instants this handler compares are the store's, not the app hosts': an Entry's **Write time** is derived from
its age at write and stamped on the store's own clock, so skew between an app host and Redis can never keep an
Entry a tag event should have dropped. That is the correctness-relevant comparison, and it is skew-free by
construction.

One caveat remains, and it is Next.js's own comparison, not this handler's: `entry.timestamp` is stored and
returned untouched, so skew **between app hosts** still shifts the `expire` and `revalidate` checks by that skew
when one Instance reads an Entry another wrote. Keep your app hosts on NTP. The reasoning is recorded in
[ADR 0002](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/docs/adr/0002-entry-write-time-on-redis-clock.md)
and [ADR 0003](https://github.com/flolefebvre/nextjs-redis-cache-handler/blob/main/docs/adr/0003-handler-clock.md).

## The `static` slot: never use it

Next.js's resolved config always contains a third Handler slot named `static`. It is reserved, unused and
misleadingly named: nothing in Next.js 16.3 selects it, and writing `'use cache: static'` fails at prerender
under webpack and at compile time under Turbopack. Never configure it, and never write `'use cache: static'`.

## Environment variable reference

Read by the Zero-config entry, and by `optionsFromEnv` in your own module. A variable that is unset or empty
leaves its option at the factory's default.

| Variable                               | Option              | Unit                         | Default             |
| -------------------------------------- | ------------------- | ---------------------------- | ------------------- |
| `REDIS_URL`                            | `url`               | URL                          | — (cache disabled)  |
| `NEXT_REDIS_CACHE_KEY_PREFIX`          | `keyPrefix`         | verbatim                     | `next-cache:`       |
| `NEXT_REDIS_CACHE_MAX_TTL`             | `maxTtl`            | seconds                      | `2592000` (30 days) |
| `NEXT_REDIS_CACHE_MAX_ENTRY_SIZE`      | `maxEntrySize`      | bytes                        | `1048576` (1 MiB)   |
| `NEXT_REDIS_CACHE_OPERATION_TIMEOUT`   | `operationTimeout`  | milliseconds                 | `1000`              |
| `NEXT_REDIS_CACHE_UPDATE_TAGS_TIMEOUT` | `updateTagsTimeout` | milliseconds                 | `5000`              |
| `NEXT_REDIS_CACHE_DEBUG`               | `debug`             | `1` / `true` / `0` / `false` | `false`             |

No variable covers `client`, `onEvent` or `onError`: an app that needs one of those calls the factory itself.

A value that is no whole number, or no boolean, throws at module load naming the variable; a value the factory
refuses names the option it maps to, so `NEXT_REDIS_CACHE_MAX_TTL=0` throws `` `maxTtl` must be a positive
integer ``. Every variable is parsed before the URL is looked at, so an unusable value is reported on a host that
has no `REDIS_URL` too.

## License

MIT
