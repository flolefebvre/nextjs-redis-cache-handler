# What is the `static` slot in `cacheHandlers`?

Resolves issue #13 (part of #1). Researched 2026-08-21 against `next@16.3.2`
(pristine install at `/tmp/next-probe/node_modules/next`; paths below are
relative to that package root, line numbers refer to the compiled `dist/**/*.js`
that actually runs), the shipped docs (`dist/docs/01-app/**`), the upstream
`vercel/next.js` history, and a throwaway probe app built with the same
`next@16.3.2` under both bundlers (`/tmp/static-slot-probe`).

## Answer

**Nothing selects it, nothing writes to it, nothing reads from it.** The
`static` key is a vestige of the first `cacheHandlers` wiring from October
2024. It is declared in the default config and in the `NextConfig` type, but
no directive, no build phase, no platform hook and no line of the 16.3 server
ever looks up a Handler slot named `static`. It behaves exactly like any other
`'use cache: <custom>'` name, with one quirk: because the key is *always*
present in the resolved config (even when its value is `undefined`), webpack
builds accept `'use cache: static'` at compile time and only fail at the first
cached call, whereas Turbopack rejects it at compile time like any unknown
kind.

**Recommendation: warn, briefly.** Do not document `static` as a slot users
may point at Redis, and do not pick it as a suggested custom slot name. One
"do not use `static`" note is enough: the name promises a build-time or
prerender tier that does not exist, the key is reserved by Next.js (env var +
typed key) and could acquire semantics in a later release, and it is the only
slot name whose error behaviour differs between bundlers.

## Evidence

### 1. Where the key comes from

The default config object hard-codes three env-driven slots; the TS source
(recovered from the sourcemap) carries no comment about any of them.

```js
// dist/server/config-shared.js:185-189
cacheHandlers: {
    default: process.env.NEXT_DEFAULT_CACHE_HANDLER_PATH,
    remote: process.env.NEXT_REMOTE_CACHE_HANDLER_PATH,
    static: process.env.NEXT_STATIC_CACHE_HANDLER_PATH
},
```

The public type lists it as an optional string next to `default` and `remote`
and then opens the record to any name **[source]** `dist/server/config-shared.d.ts:1307-1312`:

```ts
cacheHandlers?: {
    default?: string;
    remote?: string;
    static?: string;
    [handlerName: string]: string | undefined;
};
```

`NEXT_STATIC_CACHE_HANDLER_PATH` appears in exactly two compiled files, both
the config default above (`dist/server/config-shared.js:188`,
`dist/esm/server/config-shared.js:157`). No other code reads that env var.

### 2. Nothing special-cases `static`

Greps over the non-minified server and build code
(`dist/**/*.js`, excluding `dist/compiled`) for `'use cache: static'`,
`getCacheHandler('static')`, `kind === 'static'`, `handlersMap.set('static'`,
`cacheHandlers.static`, `StaticCache` return **nothing**. Specifically:

- The registry only pre-registers `default` and `remote` (both pointing at the
  in-memory built-in when not configured) **[source]**
  `dist/server/use-cache/handlers.js:97-122`. `static` is never put in the map
  unless `setCacheHandler('static', …)` is called for a configured path.
- Config validation treats every key identically (reject `private`, enforce
  `/^[a-z-]+$/`, check the file exists); no branch mentions `static`
  **[source]** `dist/server/config.js:1067-1103`.
- Every loader skips falsy values, so the undefined default is inert:
  `next start` **[source]** `dist/server/next-server.js:585-594`
  (`if (!handler) continue;`), route modules **[source]**
  `dist/server/route-modules/route-module.js:253-268`, build workers
  **[source]** `dist/export/helpers/create-incremental-cache.js:29-33`, the
  edge loaders **[source]**
  `dist/build/webpack/loaders/next-edge-ssr-loader/index.js:39-41`,
  `required-server-files.json` **[source]** `dist/build/index.js:1079-1084`
  (`if (key && value)`), build traces **[source]**
  `dist/build/collect-build-traces.js:163-170`, and the adapter output
  **[source]** `dist/build/adapter/build-complete.js:1405-1411`.
- The `'use cache'` wrapper resolves the slot with a plain map lookup on the
  directive's kind and throws `E248 Unknown cache handler: <kind>` when it is
  missing **[source]** `dist/server/use-cache/use-cache-wrapper.js:1160-1167`.
  There is no fallback from `static` to `default`.

### 3. The docs never mention it

`cacheHandlers.md:63-64` lists the slots as "`default`: Used by the
`'use cache'` directive" and "`remote`: Used by the `'use cache: remote'`
directive", full stop. `use-cache.md` only cross-references `remote` and
`private` (`:22-23`, `:211-218`, `:460`). The adapter docs describe
`cacheHandlers` as "`'use cache'` directive backends and tag coordination"
with no per-slot detail **[docs]** `07-adapters/07-runtime-integration.md:6,11`,
`02-guides/deploying-to-platforms.md:51,72`. A grep of `dist/docs` for
`use cache: static` and `CACHE_HANDLER_PATH` returns nothing.

### 4. Upstream history: a placeholder that was deleted the same day

- **PR #71455** (`c228a6e65d`, merged 2024-10-19, "Add default cache handler
  and update tags manifest handling") added the three env-driven keys to
  `config-shared.ts` and two placeholder files,
  `server/lib/cache-handlers/remote.ts` and
  `server/lib/cache-handlers/static.ts`. `static.ts` was four lines:

  ```ts
  /*
    This is the static "use cache" handler it defaults
    to a filesystem cache unless customized
  */
  ```

  The PR body says the wiring "does not make custom ones able to be leveraged
  yet".
- **PR #71505** (`b05c26f2e8`, merged 2024-10-19, "Add handling for custom
  cache handlers") deleted both placeholders, wired `default` and `remote`
  into the wrapper, and added no reference to `static` anywhere (grep of the
  diff for `NEXT_STATIC`, `'static'`, `StaticCache`: empty). The
  filesystem-backed "static" handler described in the comment was never
  written.
- The three keys have shipped unchanged in every release tag checked:
  `v15.0.0`, `v15.1.0` … `v15.5.0`, `v16.0.0` … `v16.3.0` (fetched
  `config-shared.ts` at each tag). PR #85157 moved `cacheHandlers` out of
  `experimental` for 16.0 without touching them.
- **PR #72832** (merged 2024-11-17, "Emit build error for unknown cache
  kinds") is where the compile-time check below comes from; its e2e fixture
  sets `cacheHandlers: {}` with the comment "overwrite the default config",
  i.e. the Next.js team itself has to blank the three default keys to test an
  unknown kind.

### 5. The bundler quirk: the always-present key leaks into SWC's allow-list

SWC's `'use cache'` transform accepts a directive kind only if it is in
`cacheKinds`, which is built as **[source]** `dist/build/swc/options.js:173-177`:

```js
cacheKinds: ['default', 'remote', 'private'].concat(cacheHandlers ? Object.keys(cacheHandlers) : [])
```

- **webpack** passes `nextConfig.cacheHandlers` through unfiltered
  **[source]** `dist/build/webpack/loaders/next-swc-loader.js:174`, so
  `Object.keys` yields `['default', 'remote', 'static']` even when all three
  are `undefined`. `'use cache: static'` therefore compiles.
- **Turbopack** serialises the config for Rust after dropping null values
  **[source]** `dist/build/swc/index.js:699-700`
  (`.filter(([_, value]) => value != null)`), so `static` is unknown unless
  configured. The native binary contains the message `Unknown cache kind`
  (`@next/swc-linux-x64-gnu/next-swc.linux-x64-gnu.node`).

Probe (`app/static/page.js` starting with `'use cache: static'`,
`cacheComponents: true`, no `cacheHandlers` in `next.config.js`):

| Bundler | Result |
| --- | --- |
| `next build` (Turbopack) | compile error: `Unknown cache kind "static". Please configure a cache handler for this kind in the cacheHandlers object in your Next.js config.` |
| `next build --webpack` | compiles; fails during static generation: `Error occurred prerendering page "/static" … Error: Unknown cache handler: static … digest: '…@E248'` |

No other custom name behaves this way; `'use cache: foo'` is rejected at
compile time by both bundlers (that is the #72832 test).

### 6. What a configured `static` handler actually receives

Probe with `cacheHandlers: { static: require.resolve('./handler.js') }`, a
logging handler, one page per directive, a runtime-rendered page using plain
`'use cache'`, and a route calling `revalidateTag('probe-tag', 'max')`.

- **`next build`**: the handler logged exactly one `refreshTags`, one `get`
  and one `set`, all for the `'use cache: static'` page's Entry. The plain
  `'use cache'` pages went to the built-in `default` handler.
- **`next start`**, `GET /dyn` (plain `'use cache'` inside a dynamic hole) twice:
  the `static` handler logged nothing. `refreshTags` and `getExpiration` are
  awaited per slot, keyed by the directive's kind **[source]**
  `use-cache-wrapper.js:2125` (`workStore.refreshTagsByCacheKind.get(kind)`),
  `:2153` (`expirationsByCacheKind.get(kind)`), so a slot nobody reads is
  never refreshed.
- **`next start`**, `GET /api/reval`: the `static` handler logged
  `updateTags ['probe-tag'] { expire: 31536000 }`. `updateTags` fans out to
  every registered handler object regardless of which slot wrote the tag
  **[source]** `dist/server/revalidation-utils.js:126-132`.

So pointing `static` at Redis would: load the module in every server and
build-worker process, subscribe it to every `revalidateTag`/`updateTag`
fan-out, and otherwise leave it idle unless the app writes
`'use cache: static'`, in which case it is an ordinary custom slot with no
prerender, build-time or filesystem semantics whatsoever.

## Implications for `@flefebvre/nextjs-redis-cache-handler`

1. **Do not document `static` as a supported slot.** The README and the
   `next.config` examples should show `default` and/or `remote` (and "any
   custom name") only.
2. **One warning line**, near the custom-slot guidance: "`static` is a
   reserved, unused key in Next.js 16.3's default config. It has no special
   behaviour, its name is misleading, and `'use cache: static'` errors
   differently under webpack and Turbopack when the slot is not configured.
   Avoid it." Cite this file.
3. **Nothing to implement.** The handler does not need to know which slot it
   is mounted under; `static` would receive the same `updateTags` fan-out as
   any other slot, which the Tag manifest already handles.
4. If a user reports `E248 Unknown cache handler: static` from a webpack
   build, the cause is a stray `'use cache: static'` directive, not a handler
   bug.

## Probe reproduction

```
mkdir /tmp/static-slot-probe && cd $_
npm i next@16.3.2 react@19.2.0 react-dom@19.2.0
# next.config.js: { cacheComponents: true, cacheHandlers: { static: require.resolve('./handler.js') } }
# handler.js: Map-backed CacheHandler that console.error()s every method call
# app/static/page.js: 'use cache: static'   app/plain/page.js: 'use cache'
# app/dyn/page.js: <Suspense> + connection() + a 'use cache' function
# app/api/reval/route.js: revalidateTag('probe-tag', 'max')
npx next build            # Turbopack
npx next build --webpack
npx next start -p 3124 & curl localhost:3124/dyn; curl localhost:3124/api/reval
```
