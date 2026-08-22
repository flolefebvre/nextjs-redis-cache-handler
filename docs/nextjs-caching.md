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
**[measured]** means observed on the fixture prototype
(branch `prototype/e2e-fixture`, `next@16.3.2`, two `next start` instances on
one build). Where docs and source disagree, the source wins and the
disagreement is listed in [Docs vs source](#docs-vs-source). Longer traces live in
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

**The multi-instance consequence.** A statically prerendered route (a page
whose whole output is cacheable, `○` in the build summary) is served from the
ISR cache's copy of its HTML and never calls `cacheHandlers` at serve time
(`x-nextjs-cache: HIT`, `x-nextjs-prerender: 1`). The `incrementalCache`
half of the fan-out only reaches the instance that ran the revalidation API,
so after `updateTag()` on instance A, instance B keeps serving its old HTML
**[measured]** until either a revalidation API runs on B, or B's copy passes
its ISR `revalidate` window. That window is not indefinite: `next build`
sets the route's `initialRevalidateSeconds` to the minimum `cacheLife`
`revalidate` of the Entries the prerender used (default profile: 900 s), and
once past it B serves the stale copy one more time and regenerates it in the
background from the shared Entries **[source]** `use-cache-wrapper.js:551-567`
(`propagateCacheLifeAndTagsToRevalidateStore`: union of tags, min of
`revalidate`/`expire`/`stale`), `dist/build/index.js:1942-1957`
(`getCacheControl`), `dist/server/response-cache/index.js` (`isStale === true`
serves stale and revalidates; `-1` blocks). Staleness on B is therefore
bounded by the route's `revalidate`, unbounded only when every Entry is
`revalidate: false` (`INFINITE_CACHE`); the `max` profile is 30 days. The
`'use cache'` Entries underneath *do* propagate (B's eventual re-render hit
A's fresh Entry); only the page shell is per-instance. Dynamic / PPR routes
(a `<Suspense>` boundary whose content depends on request data) read their
Entries on every request and see propagation immediately; in a PPR route this
holds for Entries used inside the dynamic hole, while its static shell is an
ISR copy like any prerendered route **[unverified]**. Sharing the ISR cache is
the singular `cacheHandler`'s job, outside this document and this library;
Next.js documents the per-instance behaviour itself **[docs]**
`incremental-static-regeneration.md` ("Multi-instance"), `self-hosting.md`
("Configuring Caching"), `deploying-to-platforms.md` (`cacheHandler` for ISR,
`cacheHandlers` for `'use cache'`). A custom singular handler is not seeded by
`next build` either: pages are written to `.next/server/app` and only the
built-in `FileSystemCache.get` reads them as seed data **[source]**
`dist/export/routes/app-page.js`, `dist/server/lib/incremental-cache/index.js`.

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
The `static` key is a vestige: nothing selects, writes or reads a slot by
that name (no directive, no build phase, no platform hook), and the shipped
docs never mention it **[source]** `handlers.js:97-122`, `config.js:1067-1103`;
upstream it was added with a never-implemented placeholder file in PR #71455
and left behind when PR #71505 deleted the placeholder. `'use cache: static'`
is just a custom slot, with one quirk: because the key is always present,
webpack compiles the directive when the slot is unconfigured and fails at
prerender with `E248`, while Turbopack rejects it at compile time (the Rust
config drops `undefined` values, `swc/index.js:699-700`; webpack passes the
keys unfiltered into SWC's `cacheKinds`, `swc/options.js:173-177`,
`next-swc-loader.js:174`). Do not document or suggest `static` as a slot;
see `docs/research/static-slot.md`.

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

The key is opaque to the handler: a string safe to use as a Redis key after
prefixing. **[measured]** 73–85 bytes for a 21-char build id, a 42-hex
function id and zero or one small argument, e.g.
`["xErB8FdynePlOh-gdL1zC","c024a7da…9dbc",[{"id":1}]]`; a component's props
arrive as a single object argument. Keys grow with the arguments, not with
the output.

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
- Edge-bundled routes bundle the handler statically: the loader emits
  `import edgeCacheHandler_N from "<handlerPath>"` for every `cacheHandlers`
  entry, so an entry that reaches `redis` — hence `node:net`, `node:tls`,
  `node:crypto` — fails the build **[source]**
  `dist/build/webpack/loaders/next-edge-ssr-loader/index.js:39-57`,
  `dist/build/webpack/loaders/next-edge-app-route-loader/index.js:16-36`.
  Measured on 16.3.2, both bundlers: webpack fails to compile
  (`Can't resolve 'stream'`, `UnhandledSchemeError: node:url`), Turbopack
  compiles and then fails collecting page data
  (`Cannot find module 'node:crypto'`).
- Which routes are Edge-bundled, with `cacheComponents: true`, is narrower than
  it looks. An **app**-router `export const runtime = 'edge'` is rejected
  outright — `Route segment config "runtime" is not compatible with
  nextConfig.cacheComponents` — so the reachable case is the **pages** router:
  `export const config = { runtime: 'experimental-edge' }` on a page goes
  through `next-edge-ssr-loader` and pulls the handler in. A pages **API**
  route (`next-edge-function-loader`) and `middleware.ts`
  (`next-middleware-loader`) inject no `cacheHandlers`.
- The `edge-light` condition (`edgeConditionName` in
  `dist/build/webpack-config-rules/resolve.js`) is honoured by **both**
  bundlers, but only for **bare specifiers**. Neither registration form is
  one: `handlerPath` and `require.resolve('…/handler')` are filesystem paths,
  and the loader's `contextifyImportPath` turns them into a relative file
  import, for which no condition is consulted. A **package self-reference**
  is the way back into the `exports` map: `dist/handler.js` is a re-export of
  `@flefebvre/nextjs-redis-cache-handler/handler-target`, an internal subpath
  whose `edge-light` condition names the Edge target. A user's own handler
  module importing `@flefebvre/nextjs-redis-cache-handler` is a bare specifier
  already, and `.` carries the condition directly.
- Do not derive a path from `import.meta.url` in a module that can reach an
  Edge bundle. Measured on 16.3.2: webpack yields a `blob:` URL, and Turbopack
  emits the imported file into `.next/static/media/` as a client asset,
  dragging the Node.js target and its `redis` import into the client output.
- `cacheMaxMemorySize` is not passed to custom handlers; it only sizes the
  built-in LRU and the `IncrementalCache` memory tier.

## Process lifecycle around the handler

**[source]** `packages/next/src/build/index.ts:2191`,
`packages/next/src/server/lib/start-server.ts:399-464`,
`packages/next/src/cli/next-build.ts:38-45` (read at the `v16.3.2` tag of the
repository; line numbers are the TypeScript source, not `dist/`).

- `next build` sets `process.env.NEXT_PHASE = 'phase-production-build'`
  immediately before forking its static-generation workers, so every worker
  that imports the handler inherits it; Next.js's own test suites use exactly
  this sentinel. Neither `next start` nor `next dev` sets `NEXT_PHASE`; they
  differ by `NODE_ENV` (`production` / `development`).
- On `SIGINT`/`SIGTERM`, `next start` (unless `NEXT_MANUAL_SIG_HANDLE` is
  set) stops accepting connections, drains in-flight requests, awaits
  `nextServer.close()`, then calls `process.exit(130 / 143)`. The handler is
  never notified and nothing on the `CacheHandler` interface is called: the
  Redis socket simply drops. Handler calls keep working during the drain.
  `next build` exits the same way on a signal. The handler therefore needs no
  shutdown hook for correctness; every write being one atomic unit is what
  makes an abrupt exit safe.

## Measured: entry sizes and call order

From the fixture prototype **[measured]**: a list page over a cached
`getPosts()` (50 posts), a PPR detail page with a cached `PostBody` over
`getPost(id)` and a nested cached `Comments` over `getComments(id)`
(`cacheLife('short')`), and a 500-row table.

| Entry | RSC bytes in `set` | Note |
| --- | ---: | --- |
| cached component, one 6-paragraph article | 4 174 | |
| cached data fn, one post | 4 106 | |
| cached component, 20 comments | 5 360 | |
| list page, 50 titles + excerpts | 18 939 | HTML 40 770 |
| cached data fn, 50 full posts | 206 182 | 10× the page that consumes it |
| 500 rich table rows | 528 533 | HTML 1 031 601, ≈1 KB/row |

RSC is roughly half the HTML for markup-heavy output. Large Entries come from
cached **data functions**, whose Entry holds everything they return, not from
pages, which render a slice of it.

Call order per request on a dynamic route:

1. `refreshTags()` once, before the first `get`; on a post-action re-render
   it runs right after `updateTags` resolved.
2. `get(key, softTags)` for every cache scope reachable in parallel,
   outermost first; inner scopes are read only when their outer scope missed
   or is regenerating. `softTags` for `/posts/1`: `_N_T_/layout`,
   `_N_T_/posts/layout`, `_N_T_/posts/[id]/layout`, `_N_T_/posts/[id]/page`,
   `_N_T_/posts/1`; for `/`: `_N_T_/layout`, `_N_T_/page`, `_N_T_/`,
   `_N_T_/index`.
3. `getExpiration(softTags)` once, only when at least one `get` returned an
   Entry.
4. `set` inner-first, then outer. The outer Entry's `tags` is the **union**
   of its own and its nested scopes' tags (a component without `cacheTag` is
   stored with its data function's tags), and its timings are the minimum
   over nested scopes.
5. After a tag-stale read (`get` returned `revalidate: -1`, as the default
   handler does, `default.js:86-88`) the wrapper regenerates in the
   background; if an inner scope was served stale during that regeneration,
   the regenerated outer Entry is **stored with `revalidate: -1`** and
   regenerates once more on the next read. A handler must accept a negative
   `revalidate` in `set`.
6. `next build` writes the static routes' Entries from one prerender worker,
   with the same build id `next start` later uses, and runtime reads them
   back; a build without Redis access just means the first runtime render
   rewrites them.
7. `revalidatePath('/')` yields `['_N_T_/', '_N_T_/index']`;
   `revalidatePath('/', 'layout')` yields `['_N_T_/layout']` and expires every
   Entry on every instance.

A server action can be driven without a browser: `POST` the page URL with
`Next-Action: <id>` (ids in `.next/server/server-reference-manifest.json`),
`Content-Type: text/plain;charset=UTF-8` and body `[]`.

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

- Whether `unstable_cache()` inside a cache scope lowers the Entry's
  `revalidate` (source comment says yes; path not traced).
- Behaviour of a `cacheHandlers` handler under `output: 'standalone'` beyond
  the path rewrite in `required-server-files.json` (`dist/build/index.js:
  1079-1099`).
