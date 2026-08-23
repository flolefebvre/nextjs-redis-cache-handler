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
