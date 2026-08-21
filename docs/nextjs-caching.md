# Next.js caching, as seen from a `cacheHandlers` handler

What each Next.js 16.3 caching feature does, and how (or whether) it reaches a
`cacheHandlers` handler: which handler method is called, with what arguments,
and where that was read. Vocabulary follows `CONTEXT.md` (Entry, Explicit tag,
Soft tag, Stale, Expired, Tag manifest, Handler slot).

**Sources.** Everything marked **[source]** was read from a pristine
`next@16.3.2` install; paths are relative to the `next` package root and line
numbers refer to the compiled `dist/**/*.js`. **[docs]** means the Markdown
shipped in `dist/docs/01-app/`. Anything marked **[unverified]** has not been
traced to source yet and should be replaced by the ticket that verifies it.
Where docs and source disagree, the source wins and the disagreement is listed
in [Docs vs source](#docs-vs-source). Longer traces live in
`docs/research/use-cache-wrapper.md` (the `'use cache'` wrapper) and
`docs/research/node-redis-capabilities.md`.

## Two cache systems

Next.js has two unrelated server caches with two unrelated handler interfaces.
This document is about the first; the second is listed so nothing is
misattributed.

| Feature | Goes through | Config key |
| --- | --- | --- |
| `'use cache'`, `'use cache: remote'`, `'use cache: <custom>'` | `CacheHandler` (`get`/`set`/`updateTags`/`getExpiration`/`refreshTags`) | `cacheHandlers` (plural) |
| `'use cache: private'` | nothing on the server in production (browser memory / Resume Data Cache) | not configurable |
| `fetch()` cache, `unstable_cache()`, ISR / prerendered pages, Route Handler responses, `next/image` output, Pages Router | `IncrementalCache` (`get`/`set`/`revalidateTag`/`resetRequestCache`; kinds `APP_PAGE`, `APP_ROUTE`, `PAGES`, `FETCH`, `REDIRECT`, `IMAGE`) | `cacheHandler` (singular) |

**[source]** `dist/server/lib/patch-fetch.js` and
`dist/server/web/spec-extension/unstable-cache.js` never reference
`use-cache/handlers`; `dist/server/response-cache/types.js:24-29` lists the
`IncrementalCache` kinds. **[docs]** `incrementalCacheHandlerPath.md:9`
("not used by `'use cache'` directives"), `how-revalidation-works.md:24`.

Revalidation APIs fan out to **both** systems: `revalidateTags()` calls every
`cacheHandlers` handler, then `incrementalCache.revalidateTag()` with the same
tags **[source]** `dist/server/revalidation-utils.js:127-136`.

## The `CacheHandler` contract in one table

**[source]** `dist/server/lib/cache-handlers/types.d.ts:1-71`. Not exported
from a public path (see `docs/research/next-handler-types.md`).

| Method | Called when | Arguments | Must return |
| --- | --- | --- | --- |
| `get(cacheKey, softTags)` | leader read of a `'use cache'` scope (after intra- and cross-request dedupe) | serialized key; the route's soft tags | `Promise<CacheEntry \| undefined>`; never throw |
| `set(cacheKey, pendingEntry)` | after a miss or a background revalidation produced a value | key; `Promise<CacheEntry>` (already resolved in 16.3) | `Promise<void>`; catch own errors |
| `refreshTags()` | lazily, at most once per handler slot per request, before the first leader `get` | none | `Promise<void>`; a rejection fails every cache read of that slot in the request |
| `getExpiration(...tags)` | lazily, once per render per handler slot, awaited only when a `get` returned an entry | the route's soft tags | `Promise<number>`: `0`, a past ms timestamp, or `Infinity` |
| `updateTags(tags, durations?)` | after a Server Action / Route Handler body ran, or after a page render | encoded tag strings; `{ expire?: number }` or omitted | `Promise<void>` |

`CacheEntry` = `{ value: ReadableStream<Uint8Array>, tags: string[], stale,
timestamp, expire, revalidate }`; `timestamp` is ms since epoch, the other
three are seconds. `tags` holds explicit tags only, never soft tags
(`types.d.ts:12-15`).

## Directives

### `'use cache'`

Marks a function, component or route segment as cacheable. Its output (an RSC
payload) becomes one Entry under the `default` handler slot.

- **Handler slot**: `default`. `getCacheHandler('default')` **[source]**
  `dist/server/use-cache/use-cache-wrapper.js:1160`.
- **Methods triggered**: `refreshTags` (lazy, first leader read of the
  request) → `get(key, softTags)` → on hit, `getExpiration(softTags)` →
  on miss or background revalidation, `set(key, entry)`. Order and conditions:
  [How a read is interpreted](#how-a-read-is-interpreted).
- **Without configuration** the slot holds Next.js's built-in in-memory LRU
  (`cacheMaxMemorySize`, default 50 MB) **[source]**
  `dist/server/use-cache/handlers.js:115-122`, `config-shared.js:102`.
- **Requires** `cacheComponents: true` **[source]** `cache-life.js:16`,
  `cache-tag.js:14` (`E887`/`E886` otherwise).
- Runtime request APIs (`cookies()`, `headers()`, `searchParams`) are not
  allowed inside; pass their values as arguments instead **[docs]**
  `use-cache.md:194-196`. `draftMode().isEnabled` may be read **[docs]**
  `use-cache.md:222-226`.

### `'use cache: remote'`

Identical contract, different slot. The docs position it for output that
should live in a durable store shared across instances, accepting a network
round trip per lookup.

- **Handler slot**: `remote`.
- **Methods triggered**: the same five, same arguments.
- **Without configuration** the `remote` slot also holds the built-in LRU
  (one LRU object installed under both `default` and `remote`) **[source]**
  `handlers.js:115-122`. Configuring only `remote` leaves `'use cache'` on the
  in-memory handler. Configuring the same module for both slots yields one
  handler object (Node module cache) and `updateTags` is called once for it
  **[source]** `handlers.js:124, 190-199, 256`.
- **Nesting** **[docs]** `use-cache-remote.md:200-207`: remote inside remote
  and remote inside `'use cache'` are allowed; remote inside private, or
  private inside remote, is an error.
- Entries do not survive a deploy because the key contains the build id (see
  [Cache key](#cache-key)) **[docs]** `use-cache-remote.md:92-98`.

### `'use cache: private'`

Lets a cached scope read `cookies()`, `headers()` and `searchParams`. Output is
cached per client, not on the server.

- **Handler slot**: none. In production the value lives only in the Resume
  Data Cache / the browser; in `next dev` a dedicated built-in in-memory
  private handler is used so reloads are fast **[source]**
  `use-cache-wrapper.js:1152-1158`, `:1485-1494`. `private` is rejected as a
  `cacheHandlers` key **[source]** `dist/server/config.js:1079-1087`.
- **Methods triggered on a custom handler**: none for reads and writes.
  `updateTags` still reaches every registered handler object regardless of
  which directive wrote the tag, so a tag shared between a private scope and
  a public one is invalidated everywhere **[source]**
  `revalidation-utils.js:127-133`.
- Not available in Route Handlers **[docs]** `use-cache-private.md:48`.

### `'use cache: <custom>'`

Any `cacheHandlers` key matching `/^[a-z-]+$/` becomes a slot selectable as
`'use cache: <key>'` **[source]** `config.js:1079-1087`. An unknown slot throws
`E248` at the first cached call **[source]** `use-cache-wrapper.js:1161-1167`.
The resolved config always contains `default`, `remote` and `static` keys
(env-driven, usually `undefined`) **[source]** `config-shared.js:185-189`.
**[unverified]** what the `static` slot is for; no ticket has traced it.

## Cache key

The `cacheKey` string passed to `get`/`set` is the React Flight
(`encodeReply`) serialization of `[buildId, functionId, args]`, plus the HMR
refresh hash in dev **[source]** `use-cache-wrapper.js:1494-1507`.

1. **Build id**: `workStore.deploymentId || workStore.buildId`
   (`:1353`). A new build therefore produces new keys; old Entries are never
   read again and must age out by TTL (the map's "never delete on startup"
   rule follows from this).
2. **Function id**: the Server Action-style id of the cached function
   (`cache(kind, id, boundArgsLength, originalFn, args)`, `:1094`).
   **[docs]** `use-cache.md:79`: "a secure hash of the function's location
   and signature".
3. **Arguments**: the call arguments, with closed-over variables bound as a
   leading `boundArgs` argument (`:1482`). Non-serializable arguments become
   opaque references that are passed through rather than keyed
   **[docs]** `use-cache.md:154`.
4. **Root params**: when the function reads root params, the key gets a
   suffix `JSON.stringify([[name, value], ...])` sorted by name
   (`:195-205`, `:1623`). Before Next.js knows which root params a function
   reads, it first reads a *redirect entry* at the coarse key whose `tags`
   contain `_N_RP_<name>` markers, then re-reads at the specific key
   (`:2136-2148`). A handler must store `_N_RP_` tags verbatim and expect two
   `set` calls per generation in that case (`:353-401`).

The key is opaque to the handler: a string, typically a few hundred bytes,
safe to use as a Redis key after prefixing. **[unverified]** maximum observed
key length; the measurement prototype will record it.

## `cacheLife`: `stale`, `revalidate`, `expire`

`cacheLife(profileNameOrObject)` sets the three timings of the enclosing
`'use cache'` scope. Calling it outside a cache scope throws `E818`
**[source]** `cache-life.js:26-40`.

### Meaning of each field

| Field | Unit | Who reads it | Effect |
| --- | --- | --- | --- |
| `stale` | s | the **client router** (and dev shell staging) | how long the browser may reuse the segment without asking the server. Never compared with `timestamp` on the server; never expires a server Entry **[source]** `use-cache-wrapper.js:2228-2278`, `types.d.ts:16-20` |
| `revalidate` | s | the wrapper, after `get` | past `timestamp + revalidate*1000` the Entry is still served and regenerated in the background (stale-while-revalidate) **[source]** `:2427`; during static generation / build it is a hard miss instead **[source]** `:2286` |
| `expire` | s | the wrapper, after `get` | past `timestamp + expire*1000` the Entry is a miss and the request blocks on regeneration **[source]** `:2286`. `expire < 300` (`MIN_PRERENDERABLE_EXPIRE`) or `revalidate === 0` excludes the Entry from static prerenders **[source]** `:2172`, `dist/server/use-cache/constants.js:28` |

Invariant enforced at normalisation: `revalidate <= expire` (`E656`)
**[source]** `cache-life-profile.js:74-82`. `Infinity` is normalised to
`INFINITE_CACHE = 4294967294` so it survives JSON (`:44-48`); a handler that
derives a Redis TTL from `expire` must clamp it.

### Built-in profiles

**[source]** `dist/server/config-shared.js:148-184`.

| Profile | `stale` | `revalidate` | `expire` |
| --- | --- | --- | --- |
| `default` | `staleTimes.static` = 300 (backfilled) | 900 (15 min) | 4294967294 (never) |
| `seconds` | 30 | 1 | 60 |
| `minutes` | 300 | 60 | 3600 |
| `hours` | 300 | 3600 | 86400 |
| `days` | 300 | 86400 | 604800 |
| `weeks` | 300 | 604800 | 2592000 |
| `max` | 300 | 2592000 | 31536000 |

`default.stale` is `undefined` in the table and backfilled from
`experimental.staleTimes.static` (default 300) at config load **[source]**
`config.js:1043-1057`, `config-shared.js:260-263`. User profiles under
`cacheLife` in `next.config` are merged over these and normalised the same
way **[source]** `config.js:1021-1040`.

### How the timings land in the Entry

Every `'use cache'` scope starts from the `default` profile **[source]**
`use-cache-wrapper.js:544-546`, `:431-443`. `cacheLife()` records an
*explicit* value per field, keeping the minimum if called several times
(`cache-life.js:85-100`). When the scope finishes:

- a field with an explicit value uses it;
- otherwise the field is the **lowest** value propagated from nested
  `'use cache'` scopes and from `fetch(..., { next: { revalidate } })` calls
  inside, capped by the default profile **[source]** `:725-731` and the
  comment at `:727-728`; `patch-fetch.js:597-600` writes an explicitly set
  fetch `revalidate` into the enclosing cache store.
  **[unverified]** the same for `unstable_cache()` inside a cache scope: the
  source comment says so, the code path has not been traced.

**[docs]** `cacheLife.md:400-445` states the user-facing rule: an explicit
outer `cacheLife` always wins; without one, shorter inner lifetimes shorten
the outer Entry, longer ones cannot extend it past the default.

The Entry handed to `set` carries the resolved `{ stale, revalidate, expire }`
and `timestamp = ` the time the generation started **[source]** `:732-739`,
`:811`. An Entry with `expire === 0` is useless to store: the wrapper treats it
as expired on every read, and the built-in handler skips storing it in
production **[source]** `dist/server/lib/cache-handlers/default.js:114-124`.

## `cacheTag`: explicit tags

`cacheTag(...tags)` appends to the enclosing cache scope's tag list; outside a
cache scope it throws `E819` **[source]** `dist/server/use-cache/cache-tag.js:
13-50`. Tags are validated by `validateTags`: at most 128 tags of at most 256
characters each; longer ones are dropped with a warning; each tag is
`encodeHeaderSafe`-encoded (only characters outside `\t\x20-\x7e` are
percent-encoded, so ASCII tags are unchanged) **[source]**
`dist/server/lib/patch-fetch.js:78-101`, `dist/lib/constants.js:280-286`,
`dist/server/lib/encode-header-safe.js:38-42`.

`fetch(url, { next: { tags } })` made *inside* a cache scope adds its tags to
the same list (deduplicated) **[source]** `patch-fetch.js:339-348`. Nested
`'use cache'` scopes propagate their tags to the enclosing scope **[source]**
`use-cache-wrapper.js:750-759` (`maybePropagateCacheEntryMetadata`).

**Reaches the handler as**: `entry.tags` in `set`. Returned unchanged by
`get`; the wrapper uses them to detect `_N_RP_` redirect entries and to
discard Entries whose tag was revalidated in the current request
**[source]** `:2138-2142`, `:2571`.

## Soft tags

Next.js derives tags from the route being rendered so that `revalidatePath`
can ride the tag system. Prefix `_N_T_` (`NEXT_CACHE_IMPLICIT_TAG_ID`). For a
render of `/blog/hello` served by `app/blog/[slug]/page.tsx` the set is
**[source]** `dist/server/lib/implicit-tags.js:15-42, 58-79`:

- `_N_T_/layout`, then one `_N_T_<segment>/layout` per ancestor segment
  (`_N_T_/blog/layout`, `_N_T_/blog/[slug]/layout`);
- `_N_T_/blog/[slug]/page` (the route file path);
- `_N_T_/blog/hello` (the concrete pathname; omitted while fallback params are
  unknown);
- `_N_T_/` and `_N_T_/index` alias each other.

Soft tags are **never** in `entry.tags`. They reach the handler in two places,
for every slot, on every render:

- as the `softTags` argument of `get(key, softTags)` (unconditionally)
  **[source]** `use-cache-wrapper.js:1631`, `:2132`, `:2146`;
- as the argument list of `getExpiration(...softTags)`, created lazily per
  render per slot and awaited only when a `get` returned an Entry
  **[source]** `implicit-tags.js:46-57, 80-84`, `use-cache-wrapper.js:2150-2165`.

`getExpiration` return value **[source]** `use-cache-wrapper.js:2156-2163`,
`:2543`: `0` → no Entry is discarded on soft-tag grounds; a timestamp `T` →
every Entry with `timestamp <= T` is discarded (a *future* `T` discards
everything, so only return expirations `<= now`); `Infinity` → the wrapper
skips its own check and relies on `get` having compared `softTags` itself.
Soft tags are only ever revalidated immediately (`durations` omitted), so a
handler only needs their `expiredAt`.

## Revalidation APIs

None of them calls the handler directly. Each pushes
`{ tag, profile, revalidatedAt }` onto `workStore.pendingRevalidatedTags`;
`revalidateTags()` flushes the list **after** the Server Action or Route
Handler body finished (awaited before the post-action re-render) or after a
page render via `waitUntil`, grouped by profile, calling
`handler.updateTags(tags, durations)` **once per unique handler object**
**[source]** `dist/server/web/spec-extension/revalidate.js:187-215`,
`dist/server/revalidation-utils.js:67-139`,
`dist/server/app-render/action-handler.js:1010`,
`dist/server/app-render/app-render.js:1657-1668`,
`dist/server/route-modules/app-route/module.js:241-250`. Calling them during
render, inside a cache scope, inside `unstable_cache` or in
`generateStaticParams` throws **[source]** `revalidate.js:117-144`.

| API | `tags` argument to `updateTags` | `durations` | Meaning (per Next.js's default handler) |
| --- | --- | --- | --- |
| `revalidateTag(tag, 'max')` | `[encodeHeaderSafe(tag)]` | `{ expire: 31536000 }` | **stale now**, expired in one year: serve once more, regenerate in the background |
| `revalidateTag(tag, '<profile>')` | same | `{ expire: cacheLife[profile].expire }` (`Infinity` → `4294967294`; a profile without `expire` → `{ expire: undefined }`; unknown profile throws `E873` at flush time) | stale now, expired at now + `expire` |
| `revalidateTag(tag, { expire: N })` | same | `{ expire: N }` | stale now, expired at now + N; `{ expire: 0 }` = expired now |
| `revalidateTag(tag)` (deprecated, warns) | same | **omitted** | **expired now**: next read is a blocking miss |
| `updateTag(tag)` (Server Actions only, `E872` elsewhere) | same | **omitted** | expired now; additionally, the current action's re-render skips Entries created before the call |
| `revalidatePath(path)` | `['_N_T_' + encodeHeaderSafe(path without trailing slash)]`; `/` also pushes `/index` and vice versa; paths over 1024 chars are dropped with a warning | **omitted** | expired now, for the soft tag |
| `revalidatePath(path, 'page' \| 'layout')` | `['_N_T_' + encoded(path) + '/' + type]`, e.g. `_N_T_/blog/[slug]/page`, `_N_T_/layout` | **omitted** | expired now |
| `refresh()` (Server Actions only) | not called | — | only refreshes dynamic data on the client; **never touches any cache handler** **[source]** `revalidate.js:70-85` |

**[source]** for the table: `revalidate.js:42-104`, `revalidation-utils.js:
100-133`, `config-shared.js:180-184`. Reference interpretation of `durations`:
`default.js:163-192` (`durations` given → `staleAt = now`, `expiredAt = now +
expire*1000` if `expire !== undefined`; omitted → `expiredAt = now`). Its
`get` then returns `undefined` when a tag has `expiredAt <= now && expiredAt >
entry.timestamp`, and returns the Entry with `revalidate = -1` (serve now,
regenerate in background) when a tag has `staleAt > entry.timestamp`
**[source]** `dist/server/lib/incremental-cache/tags-manifest.external.js:
27-53`, `default.js:82-89`.

Independently of the handler, the wrapper discards Entries created before a
tag that was revalidated in the **current** request, or in a previous request
that redirected here (`x-next-revalidated-tags` header) **[source]**
`use-cache-wrapper.js:2585-2603`, `action-handler.js:304-306`. This covers the
window before a remote handler has propagated the tag.

## `refreshTags`: how tag state reaches other instances

One lazy `refreshTags` result is created per WorkStore (page render, Server
Action request, Route Handler invocation, build-time prerender) and per
handler slot **[source]** `dist/server/async-storage/work-store.js:65, 85-96`.
It is awaited in exactly one place: the leader path of a `'use cache'` read,
after dedupe and before `get`, only if not yet resolved **[source]**
`use-cache-wrapper.js:2125-2128`. So: at most once per slot per request; never
in requests that perform no non-deduplicated cache read; never periodically.
A rejection is cached for the request and fails every later read of that slot
**[source]** `dist/server/lib/lazy-result.js:27-37`,
`use-cache-wrapper.js:2471-2474`.

## How a read is interpreted

Per `'use cache'` call **[source]** `use-cache-wrapper.js:1977-2499`:

1. **Dedupe.** Same key in the same request joins the pending invocation
   (`:1983-2023`); concurrent requests in the same process share one fill
   (`:2053-2118`). Only the leader calls the handler.
2. **Force-revalidate** skips `get` entirely (treated as a miss) when
   `workStore.isOnDemandRevalidate`, Draft Mode is on, or in dev the request
   carries `cache-control: no-cache` (`:2131`, `:2514-2539`). In Draft Mode the
   result is also not written to the handler (`:2334`).
3. `await refreshTags()` (lazy), then `entry = await get(key, softTags)`
   (`:2132`). An exception from `get` is a render error, not a miss
   (`:2471-2474`).
4. `undefined` → miss: run the function, then `set(key, entry)`; the `set`
   promise is not awaited before responding but is tracked in
   `pendingRevalidateWrites` and awaited after Server Actions (`:403-404`,
   `revalidation-utils.js:148-149`, `action-handler.js:1010`).
5. Entry returned → await `getExpiration(softTags)`; discard if
   `timestamp <= result` or a tag was revalidated in this request after
   `timestamp` (`:2150-2166`, `:2540-2580`).
6. `now > timestamp + expire*1000` → miss, blocking regeneration; during
   static generation the same applies to `revalidate` (`:2279-2286`; dev uses
   `max(expire, 300)`).
7. Otherwise **hit**: `entry.value` is streamed as-is, metadata propagates to
   the enclosing scope (`:2358-2413`). If `now > timestamp + revalidate*1000`
   (including the `revalidate: -1` sentinel) the function is re-run in the
   background and written through `set` (`:2414-2468`).

A `get` for a key whose `set` is still pending must wait for the `set` and
return the stored Entry **[source]** `types.d.ts:41-49`; the wrapper relies on
it in the root-params joiner path (`:405-411`, `:2063-2077`).

## Where and when the handler module is loaded

**[source]** `dist/server/config.js:1067-1107`,
`dist/server/next-server.js:131, 585-595`, `dist/server/use-cache/handlers.js:
79-84, 245-271`, `dist/export/helpers/create-incremental-cache.js:29-33`,
`dist/cli/next-dev.js:303-312`.

- `cacheHandlers` values must be absolute filesystem paths (or `file://`
  URLs) that exist at config-load time; `require.resolve('@scope/pkg/handler')`
  works, a bare specifier does not (`E902`).
- Loaded with native `import()` and unwrapped `mod.default || mod` twice: the
  module must default-export (or `module.exports =`) a plain handler
  **object**; named-only ESM exports do not work.
- Once per process, guarded by `globalThis[Symbol.for('@next/cache-handlers-map')]`,
  but in several processes: the `next start` server, **every `next build`
  static-generation worker**, and the forked `next dev` server, where reads go
  through an in-memory tiered front (50 MB) before reaching the custom
  handler. Connect to Redis lazily.
- Edge runtime routes bundle the handler statically; the module must be
  bundleable if any route uses `runtime = 'edge'` **[source]**
  `dist/build/webpack/loaders/next-edge-ssr-loader/index.js:40-53`.
- `cacheMaxMemorySize` is not passed to custom handlers; it only sizes the
  built-in LRU and the `IncrementalCache` memory tier.

## What does not reach `cacheHandlers`

- `fetch()` with `cache: 'force-cache'` / `next.revalidate` / `next.tags`
  outside a cache scope, `unstable_cache()`, ISR pages and the prerendered
  static shell, Route Handler response caching, `next/image` optimized output,
  Pages Router ISR (`res.revalidate()`, `x-prerender-revalidate`): all go to
  the singular `cacheHandler` (`IncrementalCache`). `revalidateTag` /
  `revalidatePath` reach both systems.
- `'use cache: private'`: browser-side only in production (dev-only in-memory
  handler).
- `refresh()`, the client router cache and `staleTimes`: client-side only.
  `stale` is carried in the Entry for the client's benefit, not for the
  handler.

## Docs vs source

Discrepancies found while tracing; the handler follows the source.

| Docs say | Source does |
| --- | --- |
| `cacheHandlers.md:213-225, 318-325`: `updateTags` deletes every entry carrying the tag | the contract is timestamp-based; deleting turns `revalidateTag(tag, 'max')` (stale-while-revalidate) into a blocking miss |
| `cacheHandlers.md:91-107, 280-286`: `get` returns `undefined` once `now > timestamp + revalidate*1000` | that is the in-memory default handler's choice (`default.js:2-7, 76-80`); the wrapper itself serves stale between `revalidate` and `expire` (`use-cache-wrapper.js:2286, 2427`), so a remote handler can keep serving until `expire` |
| `cacheHandlers.md:180-182`, `how-revalidation-works.md:53`: `Infinity` from `getExpiration` means soft tags "should instead be passed to `get`" | `softTags` are passed to `get` in every case; `Infinity` only disables the wrapper-side comparison |
| `cacheHandlers.md:143, 423`, `self-hosting.md:273`, `how-revalidation-works.md:62`: `refreshTags` is "called periodically, but always before starting a new request" | called lazily, at most once per slot per request, only before the first leader `get` of that request |
| `cacheHandlers.md:492`: a failed `set` only means the response is still served | true, but the rejected promise is awaited after Server Actions and surfaces there; catch internally |
| `cacheHandlers.md:39-59`: `require.resolve` + `module.exports` example | works; the docs omit that the module is loaded with `import()`, in build workers, and behind a tiered front in dev |

## Still unverified

Each item is owned by a later ticket; replace the mark when traced.

- Purpose of the `static` slot in the resolved `cacheHandlers` config.
- Whether `unstable_cache()` inside a cache scope lowers the Entry's
  `revalidate` (source comment says yes; path not traced).
- Typical and maximum cache key and Entry value sizes (measurement prototype).
- Behaviour of a `cacheHandlers` handler under `output: 'standalone'` beyond
  the path rewrite in `required-server-files.json` (`dist/build/index.js:
  1079-1099`).
