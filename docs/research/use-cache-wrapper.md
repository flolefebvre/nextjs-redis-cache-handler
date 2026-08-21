# How Next.js 16.3's `'use cache'` wrapper drives the cache handler

Resolves issue #2. Every claim below was read from a pristine `next@16.3.2`
install (`/tmp/next-probe/node_modules/next`); paths are relative to that
package root and line numbers refer to the compiled `dist/**/*.js` files
shipped in the package (the sourcemaps carry the original TypeScript, but the
compiled JS is what runs). Where the shipped docs
(`dist/docs/01-app/**`) disagree with the source, the disagreement is called
out explicitly.

## Summary for the handler design

Concrete rules a Redis `cacheHandlers` implementation must follow in 16.3:

1. **Export shape.** Export one handler *object* (not a class, not a factory) as
   `module.exports = handler` (CJS) or `export default handler` (ESM). Next
   loads it with `import(pathToFileURL(abs))` then unwraps `mod.default || mod`
   twice, so named-only ESM exports do not work and the object must not itself
   have a `default` property. Configure it with an absolute path
   (`require.resolve('@scope/pkg/handler')` is fine); a bare specifier or a
   non-existent path fails config validation.
2. **Loaded once per process, but in several processes.** `next start` loads it
   once (guarded by a `globalThis` symbol). `next build` loads it in every
   static-generation worker. `next dev` loads it in the forked dev server and
   wraps it in an in-memory "tiered" front. Connect to Redis lazily.
3. **`get(key, softTags)` must never throw** (an exception is a render error,
   not a miss). Return `undefined` for misses, for entries whose hard tags were
   expired after `entry.timestamp`, and (production default-handler behaviour)
   for entries past `timestamp + revalidate*1000`; alternatively keep serving
   past `revalidate` and let the wrapper do stale-while-revalidate. Always
   return `timestamp`, `expire`, `stale`, `tags` unchanged; `revalidate` may be
   overwritten with `-1` to force a background revalidation of a served entry.
4. **A `get` for a key with an in-flight `set` must wait for that `set`** and
   then return the stored entry (the wrapper and the dev tiered handler rely on
   it). Keep a per-process `pendingSets` map like the default handler.
5. **`set(key, pendingEntry)`**: await the promise, buffer the stream, persist
   `value + tags + stale + timestamp + expire + revalidate`. `expire` is
   seconds; `Infinity` arrives as `4294967294` (`INFINITE_CACHE`), so clamp
   before using it as a Redis TTL. Storing an `expire === 0` entry is useless
   (the wrapper treats it as expired on every read). Catch your own errors: a
   rejected `set` promise is awaited after server actions.
6. **`updateTags(tags, durations)`**: `durations === undefined` means "expired
   now" (`updateTag`, `revalidatePath`, deprecated `revalidateTag(tag)`).
   `durations.expire === N` means "stale now, expired at now + N s"
   (`revalidateTag(tag, 'max')` gives `N = 31536000`; `{ expire: 0 }` gives
   `N = 0`, i.e. expired now; a custom profile gives that profile's `expire`).
   Persist per-tag `staleAt`/`expiredAt` timestamps in Redis; do not delete
   entries. It is called once per *unique handler object*, not per slot, and
   only after the action/route handler body finished.
7. **Soft tags (`_N_T_...`) are never in `entry.tags`**; they arrive only as
   `softTags` in `get` and as the `tags` argument of `getExpiration`. They are
   only ever revalidated immediately (via `revalidatePath`), so tracking their
   `expiredAt` is enough. Either (a) return from `getExpiration` the newest
   `expiredAt <= now` across the tags (never a future timestamp, else every
   entry is discarded), or (b) return `Infinity` and do the same comparison
   against `softTags` inside `get`. `softTags` are passed to `get` in both
   cases.
8. **`refreshTags()` is not periodic**: it is called lazily, at most once per
   kind per request (work store), right before the first `get` of a
   `'use cache'` leader read in that request; if it rejects, every cache read
   of that kind in the request fails. Make it cheap and catch everything.
9. **Slots.** `cacheHandlers` always exists in the resolved config, so the
   built-in LRU is always installed under `default` *and* `remote`; configuring
   only `remote` replaces only `remote`. `cacheMaxMemorySize` sizes that
   built-in LRU (and the ISR memory cache) and is not passed to custom
   handlers.
10. **`fetch()`/`unstable_cache()` never touch `cacheHandlers`**; they go
    through the singular `cacheHandler` (IncrementalCache). Revalidation APIs
    fan out to both systems.

## 1. What `updateTags(tags, durations)` receives for each revalidation API

### Call chain

None of the public APIs call the handler directly. They only push
`{ tag, profile, revalidatedAt }` records into
`workStore.pendingRevalidatedTags`
(`dist/server/web/spec-extension/revalidate.js:187-215`). Those records are
flushed by `revalidateTags()` in `dist/server/revalidation-utils.js:67-139`,
invoked from `executeRevalidates()` (`:140-154`) at these points:

- after a page render, attached to `waitUntil` (`dist/server/app-render/app-render.js:1657-1668` and `:1785`);
- after a server action, **awaited before the post-action re-render**
  (`dist/server/app-render/action-handler.js:1010`) or attached to the flight
  response `waitUntil` when page rendering is skipped (`:872-879`);
- after a route handler (`dist/server/route-modules/app-route/module.js:241-250`).

Calling any of these APIs during render, inside `'use cache'`, inside
`unstable_cache`, or inside `generateStaticParams` throws
(`revalidate.js:117-144`).

### Tag string and `durations` per API

`revalidateTags()` groups the pending records by profile
(`revalidation-utils.js:73-98`) and, per group, computes `durations`
(`:100-124`) then calls every handler (`:127-133`):

```js
if (profile) handler.updateTags(tagsForProfile, durations)   // :129
else         handler.updateTags(tagsForProfile)              // :131  (durations omitted)
```

| API | tag strings passed | `profile` stored | `durations` |
| --- | --- | --- | --- |
| `revalidateTag(tag, 'max')` | `[encodeHeaderSafe(tag)]` (`revalidate.js:50-52`) | `'max'` | `{ expire: 31536000 }` -- `workStore.cacheLifeProfiles['max'].expire` (`revalidation-utils.js:108-123`; default `max` profile `dist/server/config-shared.js:180-184`: `stale 300, revalidate 2592000, expire 31536000`) |
| `revalidateTag(tag, '<profile>')` | same | the string | `{ expire: cacheLife[profile].expire }`. User profiles are normalised at config load (`dist/server/config.js:1036-1040` -> `dist/server/use-cache/cache-life-profile.js:58-82`), so `expire: Infinity` arrives as `4294967294` (`INFINITE_CACHE`, `cache-life-profile.js:44-48`, `dist/lib/constants.js:286`). A profile without `expire` yields `{ expire: undefined }`. An unknown profile name throws `E873` at flush time (`revalidation-utils.js:111-117`), i.e. after the action body ran. |
| `revalidateTag(tag, { expire: 0 })` | same | the object, normalised by `validateAndNormalizeCacheLifeProfile` (`revalidate.js:45-49`) | `{ expire: 0 }` (`revalidation-utils.js:105-107, 119-123`) |
| `revalidateTag(tag)` (deprecated) | same; logs a deprecation warning (`revalidate.js:43-44`) | `undefined` | **omitted** (`revalidation-utils.js:131`) |
| `updateTag(tag)` | `[encodeHeaderSafe(tag)]` (`revalidate.js:66-68`); throws `E872` outside a Server Action (`:55-64`) | `undefined` | **omitted** |
| `revalidatePath(path)` | `['_N_T_' + encodeHeaderSafe(removeTrailingSlash(path))]` (`revalidate.js:91`); if the result is `_N_T_/` it also pushes `_N_T_/index` and vice versa (`:100-104`); dynamic route without `type` only warns and does nothing useful (`:94-96`); paths longer than 1024 chars are dropped with a warning (`:87-90`, `NEXT_CACHE_SOFT_TAG_MAX_LENGTH`, `dist/lib/constants.js:282`) | `undefined` | **omitted** |
| `revalidatePath(path, 'page' \| 'layout')` | `['_N_T_' + encoded(path) + '/' + type]` (`revalidate.js:92-93`), e.g. `_N_T_/blog/[slug]/page`, `_N_T_/layout` for `revalidatePath('/', 'layout')` | `undefined` | **omitted** |

`encodeHeaderSafe` percent-encodes only characters outside `\t\x20-\x7e`
(`dist/server/lib/encode-header-safe.js:38-42`); ASCII tags pass through
unchanged. `cacheTag()` applies the same encoding at write time
(`dist/server/use-cache/cache-tag.js:44-48` ->
`dist/server/lib/patch-fetch.js:78-101`, max 256 chars, max 128 tags), so
stored tags and revalidation input are already in the same canonical form.

The constants: `NEXT_CACHE_IMPLICIT_TAG_ID = '_N_T_'`,
`NEXT_CACHE_ROOT_PARAM_TAG_ID = '_N_RP_'`, `NEXT_CACHE_TAG_MAX_ITEMS = 128`,
`NEXT_CACHE_TAG_MAX_LENGTH = 256`, `NEXT_CACHE_SOFT_TAG_MAX_LENGTH = 1024`
(`dist/lib/constants.js:280-286`).

### Which handler slots are called

`revalidateTags()` iterates `getCacheHandlers()`
(`revalidation-utils.js:71, 127`), which returns the **Set of unique handler
objects** (`dist/server/use-cache/handlers.js:124, 190-199`; `setCacheHandler`
adds to the same Set, `:256`). So:

- every registered handler object gets the call, regardless of kind -- there is
  no per-kind filtering of tags;
- if the same module is configured for both `default` and `remote`, Node's
  module cache yields one object and `updateTags` is called **once**;
- the built-in in-memory handler (still installed under `default` when only
  `remote` is configured, see section 6) is also called;
- in `next dev` the dev-only private handler and the per-kind in-memory front
  handlers are also called (`handlers.js:195-216`).

In parallel, the same tags (with the same `durations`) go to the legacy
IncrementalCache (`revalidation-utils.js:134-136` ->
`dist/server/lib/incremental-cache/index.js:200-202`), which is the `fetch()`
/ `unstable_cache()` / ISR path; neither `dist/server/lib/patch-fetch.js` nor
`dist/server/web/spec-extension/unstable-cache.js` references
`use-cache/handlers` at all.

### Reference semantics (default handler)

The default handler (`dist/server/lib/cache-handlers/default.js:163-192`)
interprets the call as:

- `durations` given: `stale = now` always; `expired = now + durations.expire*1000`
  only if `durations.expire !== undefined` (`:172-183`);
- `durations` omitted: `expired = now` (`:184-190`).

Its `get` then returns `undefined` if any hard tag has
`expiredAt <= now && expiredAt > entry.timestamp`
(`dist/server/lib/incremental-cache/tags-manifest.external.js:28-43`, used at
`default.js:82-85`) and returns the entry with `revalidate = -1` if any hard
tag has `staleAt > entry.timestamp` (`tags-manifest.external.js:44-53`,
`default.js:86-89`). Note the `'max'` case is therefore "stale now, actually
expired a year later", which is the stale-while-revalidate behaviour the docs
describe (`dist/docs/01-app/03-api-reference/04-functions/revalidateTag.md`,
"Revalidation Behavior").

**Docs vs source.** `cacheHandlers.md:213-225` and `:318-325` show
`updateTags` deleting every entry carrying the tag. That implements
immediate expiration for *every* form, silently turning
`revalidateTag(tag, 'max')` into a blocking miss. The source contract is
timestamp-based, as above.

### Additional consistency mechanism the handler does not control

Even before `updateTags` runs, the wrapper discards entries that were created
before a tag revalidated in the *current* request
(`pendingRevalidatedTags`, `use-cache-wrapper.js:2594-2601`) or in a previous
request that redirected here (`previouslyRevalidatedTags`, read from the
`x-next-revalidated-tags` header, `action-handler.js:304-306`,
`use-cache-wrapper.js:2586-2593`, `requestStartTime` from
`dist/server/async-storage/work-store.js:64`). This covers the window in which
a remote handler has not propagated the tag yet.

## 2. What the wrapper does with what `get` returns

All references in this section are to `dist/server/use-cache/use-cache-wrapper.js`.

### When and how `get` is called

- Handler selection: `getCacheHandler(kind)` (`:1160`); unknown kind throws
  `E248` (`:1161-1167`). In dev a custom kind is wrapped in the tiered handler
  (`:1173-1184`).
- Intra-request dedupe: the same serialized key is read from the handler at
  most once per request; later invocations join the pending or completed
  invocation (`:1983-2023`; completed entries are retained only for private
  or custom handlers, `:2036`).
- Cross-request dedupe: concurrent requests in the same process share one
  fill through a module-level map (`:171`, `:2053-2118`).
- Leader path: awaits lazy `refreshTags` for the kind (`:2125-2128`), then
  `entry = await cacheHandler.get(cacheHandlerKey, implicitTags)` (`:2132`).
  `implicitTags` is `workUnitStore.implicitTags.tags ?? []` (`:1631`).
- The read is skipped entirely (treated as a miss) when
  `shouldForceRevalidate` is true: `workStore.isOnDemandRevalidate`,
  `workStore.isDraftMode`, and in dev a `cache-control: no-cache` request
  header (`:2131`, `:2514-2539`).
- Root params: if the returned entry's `tags` contain `_N_RP_<name>` tags it is
  a *redirect entry*; the wrapper recomputes the key with the root params and
  calls `get` a second time (`:2136-2148`). Conversely `saveToCacheHandler`
  issues two `set`s in that case: the full entry at the specific key and a
  one-byte redirect entry at the coarse key whose `tags` are the real tags
  plus the `_N_RP_` tags (`:353-401`). The handler must store `_N_RP_` tags
  verbatim.
- `get` is **not** wrapped in try/catch; an exception rejects the shared result
  and propagates as a render error (`:2471-2474`). The docs say the same
  (`cacheHandlers.md:493`, `how-revalidation-works.md:92`).

### `get` returns `undefined`

Treated as a miss (`:2279`): `generateCacheEntry` runs the cached function
(`:2317`); unless draft mode is on, the result is written to the resume data
cache and, if a handler exists, to the handler via `saveToCacheHandler`
(`:2334-2339`). The `set` promise is not awaited before responding; it is
pushed to `workStore.pendingRevalidateWrites` (`:403-404`) and awaited by
`executeRevalidates` (`revalidation-utils.js:148-149`) -- via `waitUntil`
after page renders, and **awaited** after server actions
(`action-handler.js:1010`). A rejected `set` therefore is not harmless: catch
internally. (Docs: `cacheHandlers.md:492` only says the response is still
served, which is true.)

### `get` returns an entry: order of checks

1. **Implicit-tag expiration** (`:2150-2165`): the lazy `getExpiration`
   result for the kind is awaited (section 3); if `< Infinity` it becomes
   `implicitTagsExpiration`.
2. **`shouldDiscardCacheEntry`** (`:2166`, `:2540-2580`): discard if
   `entry.timestamp <= implicitTagsExpiration` (`:2543`), or (outside a
   `prerender` work unit) if any of `entry.tags` or the implicit tags was
   revalidated in this or a redirecting previous request after
   `entry.timestamp` (`:2571-2578`, `:2585-2603`). A discarded entry is a
   miss.
3. **Dynamic-hole staging** (`:2172-2227`): if `entry.revalidate === 0` or
   `entry.expire < 300` (`MIN_PRERENDERABLE_EXPIRE`,
   `dist/server/use-cache/constants.js:28`), a static prerender omits the
   entry from the shell (returns a hanging promise); request renders still
   serve it.
4. **Shell/prefetch staging by `stale`** (`:2228-2278`): `stale < 300`
   (`MIN_SHELL_STALE`) or `< 30` (`MIN_PREFETCHABLE_STALE`) only changes which
   render stage the value resolves in (dev) -- `stale` never expires a server
   entry. `types.d.ts:16-20` says it is "for the client".
5. **Expiry** (`:2279-2286`): miss and **blocking** regeneration if
   `now > timestamp + expire*1000` (dev: `max(expire, 300)`), **or** if
   `workStore.isStaticGeneration && now > timestamp + revalidate*1000`
   (prerenders and build never serve stale entries).
6. **Hit** (`:2358-2413`): `stream = entry.value` is served as-is, metadata
   (`tags/revalidate/expire/stale/timestamp`) is propagated to the enclosing
   scope (`:2359-2377`) and the entry is cloned into the resume data cache
   when mutable (`:2382-2399`).
7. **Background revalidation** (`:2414-2468`): if
   `now > timestamp + revalidate*1000` the function is re-run in the
   background and the result written through `saveToCacheHandler`
   (`:2448-2460`); the promise is tracked in `pendingRevalidateWrites`
   (`:2466-2467`). Dev also re-warms on every request for short-`expire`
   entries or with `cacheMaxMemorySize: 0` (`:2428-2445`).

### Meaning of each field, as read by the wrapper

| Field | Unit | How the wrapper uses it |
| --- | --- | --- |
| `timestamp` | ms since epoch | set at generation start (`:811`, `:734`); every freshness and tag comparison is relative to it (`:2286`, `:2427`, `:2543`, `:2571`). Must be stored and returned unchanged. |
| `expire` | seconds | hard TTL: past it the entry is a miss (`:2286`); `< 300` marks the entry dynamic for static prerenders (`:2172`); `0` is always expired (and the default handler skips storing it in production, `default.js:114-124`); negative is an eviction sentinel **for the built-in handler only** (`default.js:55-65`; only the dev tiered handler writes it, and only into its in-memory front, `tiered-cache-handler.js:96-99, 132-143`). |
| `revalidate` | seconds | soft TTL: past it the entry is still served but regenerated in the background (`:2427`); treated as hard TTL during static generation (`:2286`); `0` marks the entry dynamic for prerenders (`:2172`, `:2181`). |
| `revalidate: -1` | sentinel | produced by the default handler when a hard tag is *stale* (`default.js:86-89`). Effect: `now > timestamp - 1000` is always true, so the entry is **served and revalidated in the background** (`:2427`). It is not `0`, so it is not a dynamic hole (`:2172`). During static generation the same comparison at `:2286` turns it into a miss. This is the handler's way to say "serve once, refresh now". |
| `stale` | seconds | client/prefetch staging only (`:2228-2278`) and propagated to the client via metadata; never compared with `timestamp` on the server. |
| `tags` | string[] | hard tags **excluding** soft tags (`types.d.ts:12-15`); used for `_N_RP_` redirect detection (`:2138-2142`) and pending-revalidation checks (`:2571`). |
| `value` | `ReadableStream<Uint8Array>` | consumed once per `get`; the default handler `tee()`s and keeps the second branch (`default.js:90-91`). A handler returning a fresh stream per call (as a Redis handler does) needs no tee. |

### Pending `set` vs `get`

`types.d.ts:41-49` requires that a `get` for a key whose `set` is still
pending waits for the `set` and returns the entry instead of `undefined`. The
default handler implements it with a `pendingSets` map (`default.js:40,
44-48, 106-110, 141-144`). The wrapper relies on it in the cross-request
joiner path: a joiner that recomputes its root-param key re-reads the handler
only after the leader's metadata resolved, and that metadata is deliberately
gated on the `set` calls landing (`:405-411`, `:2063-2077`). In 16.3 the
`pendingEntry` passed to `set` is already resolved (`Promise.resolve(entry)`,
`:373`, `:400`) and its `value` stream is a fully buffered replay
(`:690-703`), but the contract still says to `await` it.

**Docs vs source.** `cacheHandlers.md:91-107` and `:280-286` make `get`
return `undefined` once `now > timestamp + revalidate*1000`. That matches
the production default handler (`default.js:76-80`, comment at `:2-7`:
in-memory caches deliberately skip SWR) but it is a choice, not a
requirement: the wrapper itself implements stale-while-revalidate between
`revalidate` and `expire` (`:2286`, `:2427`). A Redis handler can keep
serving until `expire` and gain SWR for free.

## 3. `getExpiration`

- **Created** once per render, per kind: `getImplicitTags()` builds the
  route's soft tags and a `Map<kind, LazyResult>` whose entries call
  `cacheHandler.getExpiration(tags)` on first await
  (`dist/server/lib/implicit-tags.js:46-57, 80-84`). `getImplicitTags` is
  called from `dist/server/app-render/app-render.js:1591`,
  `dist/server/route-modules/app-route/module.js:563` and
  `dist/server/web/adapter.js:253`. It iterates `getCacheHandlerEntries()`
  (per *kind*), so a handler registered under two kinds is asked twice with
  the same tags.
- **Tags passed**: always and only soft tags: `_N_T_/layout`, one
  `_N_T_<segment>/layout` per ancestor segment, `_N_T_<page>` (the route file
  path, e.g. `_N_T_/blog/[slug]/page`), `_N_T_<pathname>` (the concrete URL
  path, omitted when fallback params are unknown), plus `_N_T_/` <->
  `_N_T_/index` aliasing (`implicit-tags.js:15-42, 58-79`). These are the
  exact strings `revalidatePath` emits (section 1).
- **Awaited** only when a `get` returned an entry, right before
  `shouldDiscardCacheEntry` (`use-cache-wrapper.js:2150-2165`); memoised for
  the rest of the request (`dist/server/lib/lazy-result.js:23-41`). If the
  request performs no `'use cache'` hit, it is never called.
- **Effect of the return value** (`use-cache-wrapper.js:2156-2163`, `:2543`):
  - `0`: `implicitTagsExpiration = 0`; since `entry.timestamp > 0`, no entry
    is discarded on soft-tag grounds by the wrapper.
  - timestamp `T` (ms): every entry with `entry.timestamp <= T` is discarded
    (miss + blocking regeneration). A **future** `T` (e.g. naively returning
    the `expiredAt` of a `'max'` revalidation) discards every entry on every
    request until `T`; return only expirations that are `<= now`.
  - `Infinity`: the wrapper keeps `implicitTagsExpiration = 0` and does no
    soft-tag check itself. It does **not** change what `get` receives:
    `softTags` are passed to `get` unconditionally (`:2132`, `:2146`), whether
    `getExpiration` returned `0`, a timestamp or `Infinity`. `Infinity` simply
    delegates the responsibility to `get`.
- **Throws**: awaited inside the leader `try` (`:2046`, `:2155`) -> the cache
  read rejects (`:2471-2474`). Catch internally and return `0`.
- The default handler returns `max(entry.expired || 0)` over the tags
  (`default.js:149-162`); since soft tags are only revalidated without
  durations (section 1), `expired` is always a past timestamp there.

**Docs vs source.** `cacheHandlers.md:180-182` and
`how-revalidation-works.md:53` say `Infinity` means the soft tags "should
instead be passed into `get`". They are passed in every case; `Infinity` only
disables the wrapper-side comparison.

## 4. `refreshTags`

- **Created** per WorkStore (`dist/server/async-storage/work-store.js:65,
  85-96`): one lazy result per kind from `getCacheHandlerEntries()` (per
  kind, so a handler under two kinds is refreshed twice; in dev the private
  handler is included, `handlers.js:227-244`). A WorkStore is created per
  page render, per server-action request, per route-handler invocation and
  per build-time prerender.
- **Awaited** in exactly one place: the leader path of a `'use cache'` read,
  after cross-request dedupe and before `get`
  (`use-cache-wrapper.js:2125-2128`), and only if the lazy result has not
  resolved yet (`isResolvedLazyResult`). Hence: not per slot, not periodic,
  not "before each request" -- at most once per kind per request, and only in
  requests that actually perform a non-deduplicated cache read of that kind.
  Joined invocations and resume-data-cache hits never trigger it.
- **Throws**: the lazy result caches the rejected promise
  (`lazy-result.js:27-37`); `await lazyRefreshTags` rejects inside the leader
  `try` (`:2046`), the shared result is rejected and the error rethrown
  (`:2471-2474`), so the `'use cache'` call rejects and every later read of
  that kind in the same request rejects too. The next request gets a fresh
  lazy result. The docs agree that it must catch its own errors
  (`how-revalidation-works.md:80`).

**Docs vs source.** `cacheHandlers.md:143, 423` and `self-hosting.md:273`
say it is "called before each request". It is called lazily as described
above; a request without a `'use cache'` leader read never calls it.

## 5. How the `cacheHandlers` module is loaded

### Config validation (`dist/server/config.js:1067-1107`)

- `cacheHandlers` must be an object (`E901`).
- Keys must match `/^[a-z-]+$/`; `private` is rejected (`:1079-1087`).
- Each value is passed through `resolveCacheHandlerPathToFilesystem`
  (`file://` URL -> path, otherwise unchanged,
  `dist/lib/format-dynamic-import-path.js:30-35`) and must satisfy
  `existsSync` (`config.js:1091-1097`, `E902`). Consequently a bare package
  specifier (`'@scope/pkg/handler'`) is rejected; `require.resolve(...)`
  returning an absolute path works, as does `path.join(__dirname, ...)`. A
  relative path is checked against `process.cwd()` at config time but
  joined with `distDir` at runtime (`format-dynamic-import-path.js:36-41`,
  `next-server.js:593`), so use absolute paths. `next build` rewrites the
  paths to be relative to `distDir` in `required-server-files.json`
  (`dist/build/index.js:1079-1084, 1099`) and traces the file into the
  standalone output (`dist/build/collect-build-traces.js:163-170`).

### Runtime loading (Node)

- `next start`: `NextNodeServer.loadCustomCacheHandlers()`
  (`dist/server/next-server.js:585-595`):
  `initializeCacheHandlers(cacheMaxMemorySize)` then, for each non-empty
  entry, `setCacheHandler(kind, interopDefault(await dynamicImportEsmDefault(formatDynamicImportPath(distDir, handler))))`.
  `dynamicImportEsmDefault` is `import(id).then(mod => mod.default || mod)`
  (`next-server.js:131`), `interopDefault` is `mod.default || mod` again
  (`dist/lib/interop-default.js:11-14`), and `formatDynamicImportPath`
  returns a `file://` URL (`format-dynamic-import-path.js:36-41`).
  Therefore: **native `import()`**, not `require`. Accepted shapes: ESM
  `export default obj`; CJS `module.exports = obj`; CJS/TS-compiled
  `exports.default = obj`. Not accepted: named-only ESM exports (the module
  namespace is registered as the handler). A handler object with its own
  `default` property would be unwrapped wrongly. `.js/.mjs/.cjs` are resolved
  by Node per `package.json#type`. A `.ts` file is neither transpiled nor
  special-cased by Next; it loads only if the Node version can strip types
  natively.
- The same code exists for route modules in minimal/standalone mode
  (`dist/server/route-modules/route-module.js:253-266`, `NEXT_RUNTIME !== 'edge'`)
  and for build-time static generation workers
  (`dist/export/helpers/create-incremental-cache.js:29-33`), i.e. the module
  is also imported in every `next build` worker process that prerenders
  pages (Redis connections will be opened at build time).
- **Once per process**: `initializeCacheHandlers` returns `false` if the
  `globalThis[Symbol.for('@next/cache-handlers-map')]` is already set
  (`handlers.js:79-84`), and all callers return early in that case
  (`next-server.js:590`, `route-module.js:259`,
  `create-incremental-cache.js:29`). `loadCustomCacheHandlers` is invoked from
  `getIncrementalCache()` on every request (`next-server.js:603`,
  `base-server.js:915`) and from `unstable_preloadEntries` (`:517`), but only
  the first call imports the module. Handlers live on `globalThis`, so one
  instance is shared across module copies (`handlers.js:74-78`).
- **Process topology**: `next start` runs the render server in-process
  (no worker fork in `dist/server/lib/start-server.js` /
  `router-server.js`); `next dev` forks one child with
  `__NEXT_DEV_SERVER=1` (`dist/cli/next-dev.js:303-312`) which loads the
  handler once, and its hang-detection probe worker skips handler selection
  entirely (`use-cache-wrapper.js:1147-1151`).
- In dev, `setCacheHandler` additionally creates a 50 MB in-memory front
  handler and a tiered handler per custom kind (`handlers.js:257-271`,
  `tiered-cache-handler.js:13-84`); reads hit the front first and the backing
  is reconciled in the background, writes go to both tiers.
- **Edge runtime**: handlers are bundled statically with
  `import edgeCacheHandler_N from "<path>"` and registered per invocation
  (`dist/build/webpack/loaders/next-edge-ssr-loader/index.js:40-53`,
  `next-edge-app-route-loader/index.js:16-30`,
  `dist/server/web/edge-route-module-wrapper.js:62-65`). If any route uses the
  edge runtime, the handler module must be bundleable for it.
- An undocumented alternative injection point exists: before
  `initializeCacheHandlers` runs, a platform can set
  `globalThis[Symbol.for('@next/cache-handlers')] = { DefaultCache, RemoteCache }`
  (`handlers.js:60, 97-114`). Instrumentation `register()` runs earlier
  (`next-server.js:573-579`), so it is reachable, but it is internal API.

**Docs vs source.** `cacheHandlers.md:39-59` shows `require.resolve(...)`
and `module.exports = { ... }` examples; both work for the reasons above. The
docs do not mention that the module is loaded with `import()`, in build
workers, or wrapped by a tiered handler in dev.

## 6. `default` left unconfigured next to a configured `remote`; `cacheMaxMemorySize`

- The resolved config always contains
  `cacheHandlers: { default: process.env.NEXT_DEFAULT_CACHE_HANDLER_PATH, remote: process.env.NEXT_REMOTE_CACHE_HANDLER_PATH, static: process.env.NEXT_STATIC_CACHE_HANDLER_PATH }`
  (`dist/server/config-shared.js:185-189`), so `if (!cacheHandlers) return`
  never fires and `initializeCacheHandlers` always runs; undefined values are
  skipped (`next-server.js:592`).
- `initializeCacheHandlers` installs **one** built-in LRU handler
  (`createDefaultCacheHandler(cacheMaxMemorySize)`) under both `default` and
  `remote` (`handlers.js:115-122`). `setCacheHandler('remote', ours)` then
  replaces only the `remote` map entry and adds our object to the Set
  (`handlers.js:255-256`). So yes: with only `remote` configured, `'use cache'`
  keeps using the in-memory LRU, `'use cache: remote'` uses Redis, and
  `updateTags` reaches both (section 1). Built-in handlers are tracked in a
  separate Set (`handlers.js:88-89, 105, 117`) used for `isBuiltInCacheHandler`
  (`use-cache-wrapper.js:2036`).
- `cacheMaxMemorySize` (default `50 * 1024 * 1024`, `config-shared.js:102`):
  - byte budget of the built-in LRU, measured as buffered value size plus key
    length (`default.js:39, 127-136`);
  - `0` swaps in a no-op handler in production (`default.js:30-37`); in dev a
    50 MB cache is used anyway and the wrapper re-warms on every request
    (`handlers.js:90-95, 130`, `use-cache-wrapper.js:2428`);
  - also passed as `maxMemoryCacheSize` to the ISR/`fetch` `IncrementalCache`
    (`next-server.js:615`);
  - **not** passed to custom handlers: `setCacheHandler(kind, handler)`
    receives only the object (`handlers.js:245`). The dev front handler is
    always 50 MB (`handlers.js:73, 268`).

## For docs/nextjs-caching.md

Facts ready to be copied (owned by another ticket):

- `revalidateTag(tag, 'max')` -> `updateTags([tag], { expire: 31536000 })`;
  `revalidateTag(tag, '<profile>')` -> `{ expire: cacheLife[profile].expire }`
  (`Infinity` arrives as `4294967294`); `revalidateTag(tag, { expire: 0 })`
  -> `{ expire: 0 }`; `revalidateTag(tag)`, `updateTag(tag)`,
  `revalidatePath(...)` -> `updateTags(tags)` with `durations` omitted
  (= expire immediately). `revalidatePath('/a/b')` sends `_N_T_/a/b`;
  `revalidatePath('/a/[x]', 'page')` sends `_N_T_/a/[x]/page`;
  `revalidatePath('/', 'layout')` sends `_N_T_/layout`; `/` and `/index` are
  aliased. Tags are `encodeHeaderSafe`-encoded (non-ASCII percent-encoded).
- `updateTags` is called after the action/route-handler body finished, once
  per unique handler object (all slots), and in parallel on the legacy
  `cacheHandler` (IncrementalCache) for `fetch`/`unstable_cache`/ISR.
- `get(key, softTags)` contract: `undefined` = miss (blocking regeneration).
  Returned entry is discarded by the wrapper if `timestamp <=
  getExpiration(softTags)` or if a tag was revalidated in this request after
  `timestamp`. Past `expire` = miss; between `revalidate` and `expire` =
  served + background regeneration; `revalidate: -1` = serve now + regenerate
  in background; `revalidate: 0` or `expire < 300 s` = excluded from static
  prerenders; `stale` never expires server entries. `get` must not throw.
- `set` receives an already resolved entry; the write is not awaited before
  the response but is awaited after server actions; `expire === 0` entries
  are never served. Two `set`s per generation when root params are read
  (coarse redirect entry tagged `_N_RP_<param>`).
- `getExpiration` is called per render per kind with the route's `_N_T_`
  soft tags only, awaited only on a cache hit; return `0`, a past timestamp,
  or `Infinity` (delegates to `get`; `softTags` are passed to `get`
  regardless).
- `refreshTags` is called lazily, at most once per kind per request, before
  the first handler `get` of that request; a rejection fails every cache read
  of that kind in the request.
- Handler modules are loaded with `import(file://...)` once per process
  (`next start`), in each build worker (`next build`), and in the forked dev
  server behind an in-memory tiered front (`next dev`); default export or
  `module.exports` of a handler object; absolute path required.
- `cacheHandlers` always exists in the resolved config; the built-in LRU is
  installed under `default` and `remote` until overridden; `cacheMaxMemorySize`
  only sizes the built-in LRU and the ISR memory cache.

## Sources

All paths relative to `/tmp/next-probe/node_modules/next` (`next@16.3.2`).

- `dist/server/lib/cache-handlers/types.d.ts` -- `CacheEntry` / `CacheHandler` contract (lines 1-71).
- `dist/server/lib/cache-handlers/default.js` -- reference in-memory handler (26-194).
- `dist/server/lib/cache-handlers/default.external.js` -- deprecated 50 MB singleton (5-16).
- `dist/server/lib/incremental-cache/tags-manifest.external.js` -- `areTagsExpired` / `areTagsStale` (27-53).
- `dist/server/use-cache/use-cache-wrapper.js` -- wrapper: 171, 330-411, 690-760, 805-815, 1094-1189, 1608-1631, 1977-2499, 2514-2603.
- `dist/server/use-cache/handlers.js` -- registry, `initializeCacheHandlers`, `setCacheHandler`, dev tiers (55-272).
- `dist/server/use-cache/tiered-cache-handler.js` -- dev tiered handler (13-143).
- `dist/server/use-cache/constants.js` -- `MIN_PRERENDERABLE_EXPIRE`, `MIN_PREFETCHABLE_STALE`, `MIN_SHELL_STALE` (28-32).
- `dist/server/use-cache/cache-life.js` -- `cacheLife()` (14-100); `dist/server/use-cache/cache-life-profile.js` -- normalisation, `INFINITE_CACHE` (12-82).
- `dist/server/use-cache/cache-tag.js` (44-48) and `dist/server/lib/patch-fetch.js` `validateTags` (78-101).
- `dist/server/web/spec-extension/revalidate.js` -- `revalidateTag`, `updateTag`, `revalidatePath`, `revalidate` (42-224).
- `dist/server/revalidation-utils.js` -- `revalidateTags`, `executeRevalidates` (24-154).
- `dist/server/app-render/app-render.js` (1591, 1657-1668, 1785), `dist/server/app-render/action-handler.js` (101-125, 304-306, 866-879, 1004-1011), `dist/server/route-modules/app-route/module.js` (241-250, 563), `dist/server/web/adapter.js` (253).
- `dist/server/lib/implicit-tags.js` -- soft tags and lazy `getExpiration` (15-85).
- `dist/server/async-storage/work-store.js` -- lazy `refreshTags`, `requestStartTime` (38-96).
- `dist/server/lib/lazy-result.js` (23-44).
- `dist/server/lib/encode-header-safe.js` (1-42).
- `dist/lib/constants.js` -- tag constants (276-286).
- `dist/server/config.js` -- `cacheLife` normalisation (1024-1042), `cacheHandlers` validation (1067-1107); `dist/server/config-shared.js` -- defaults (100-102, 146-189); `dist/server/config-schema.js` (214).
- `dist/server/next-server.js` -- `dynamicImportEsmDefault` (131), `unstable_preloadEntries` (513-517), `loadCustomCacheHandlers` / `getIncrementalCache` (585-620); `dist/server/base-server.js` (912-920); `dist/lib/interop-default.js` (11-14); `dist/lib/format-dynamic-import-path.js` (30-41).
- `dist/server/route-modules/route-module.js` (253-266); `dist/export/helpers/create-incremental-cache.js` (23-34); `dist/build/index.js` (1077-1099); `dist/build/collect-build-traces.js` (150-170).
- `dist/build/webpack/loaders/next-edge-ssr-loader/index.js` (40-53), `dist/build/webpack/loaders/next-edge-app-route-loader/index.js` (16-30), `dist/server/web/edge-route-module-wrapper.js` (62-65).
- `dist/cli/next-dev.js` (303-312); `dist/server/lib/start-server.js`, `dist/server/lib/router-server.js` (no worker fork).
- Docs: `dist/docs/01-app/03-api-reference/05-config/01-next-config-js/cacheHandlers.md`; `dist/docs/01-app/02-guides/how-revalidation-works.md`; `dist/docs/01-app/03-api-reference/04-functions/{revalidateTag,updateTag,revalidatePath}.md`; `dist/docs/01-app/03-api-reference/05-config/01-next-config-js/cacheLife.md`; `dist/docs/01-app/02-guides/self-hosting.md` (109-113, 164, 209, 273).
