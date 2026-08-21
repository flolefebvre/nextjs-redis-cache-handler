# Are `CacheHandler` / `CacheEntry` publicly exported by `next@16.3`?

Resolves issue #3 (part of #1). Researched 2026-08-21 against `next@16.3.2` (pristine install at `/tmp/next-probe/node_modules/next`), older tarballs from the npm registry, and the upstream `vercel/next.js` repo.

## Answer

**No.** `next@16.3.2` has no public entry point for the `"use cache"` handler types. `CacheHandler`, `CacheEntry` and `Timestamp` are only declared in the deep path `next/dist/server/lib/cache-handlers/types.d.ts` and are not re-exported from `next`, `next/types` or `next/cache`.

However:

- The deep path **is importable** under `moduleResolution: bundler`, `node16` and `nodenext`, because `next`'s `package.json` has **no `exports` map at all** (and no `typesVersions`), so Node/TS subpath encapsulation does not apply.
- The deep path and its contents are **byte-identical across every 16.x release checked** (16.0.0, 16.1.0, 16.2.0, 16.3.0, 16.3.1, 16.3.2).
- The same path **did change incompatibly between 15.5 and 16.0** (V1 interface removed, `CacheHandlerV2` renamed to `CacheHandler`, `getExpiration`/`updateTags` signatures changed). Stability holds within a major, not across majors.
- The official `cacheHandlers` docs link to the TypeScript *source* file on GitHub as the authoritative interface, not to an importable path.

## Evidence

### 1. No `exports` / `typesVersions`; `types` points at `index.d.ts`

```
$ cd /tmp/next-probe/node_modules/next && node -e 'const p=require("./package.json");console.log(p.version, p.types, p.typesVersions, p.exports)'
16.3.2 index.d.ts undefined undefined
```

`files` in `package.json` includes `"dist"` in full, so every `dist/**/*.d.ts` ships in the tarball. With no `exports` field, any `next/dist/...` subpath is reachable by Node's legacy resolution and by TypeScript under all `moduleResolution` modes.

### 2. The root `.d.ts` entry points do not re-export the handler types

- `/tmp/next-probe/node_modules/next/cache.d.ts`: exports `unstable_cache`, `revalidatePath`, `revalidateTag`, `updateTag`, `refresh`, `unstable_noStore`, `io`, `cacheTag`, `cacheLife`, `unstable_cacheLife`, `unstable_cacheTag`. No types for handlers.
- `/tmp/next-probe/node_modules/next/types.d.ts`: `export * from './dist/types'; export { default } from './dist/types'`.
- `/tmp/next-probe/node_modules/next/index.d.ts`: triple-slash references to the root `.d.ts` files plus `export * from './types'`.
- `/tmp/next-probe/node_modules/next/dist/types.d.ts`: `grep -n -i cache dist/types.d.ts` returns nothing. Its exports are `NextConfig`, `NextAdapter`, `AdapterOutput`, `Metadata*`, `Viewport*`, `Instant`, `Instrumentation`, `RouterTransition*`, `Route`, `Redirect`, `NextPage`, `PageConfig`, `GetStaticProps*`, `GetServerSideProps*`, etc.

### 3. Every `.d.ts` that mentions the types imports them from the deep path

```
$ grep -rn --include='*.d.ts' "cache-handlers/types" . | grep -v '/node_modules/'
dist/server/lib/incremental-cache/tags-manifest.external.d.ts:1:import type { Timestamp } from '../cache-handlers/types';
dist/server/web/edge-route-module-wrapper.d.ts:5:import type { CacheHandler } from '../lib/cache-handlers/types';
dist/server/use-cache/clone-cache-entry.d.ts:1:import type { CacheEntry } from '../lib/cache-handlers/types';
dist/server/use-cache/use-cache-wrapper.d.ts:1:import type { CacheEntry } from '../lib/cache-handlers/types';
dist/server/use-cache/handlers.d.ts:1:import type { CacheHandler } from '../lib/cache-handlers/types';
dist/server/use-cache/tiered-cache-handler.d.ts:1:import type { CacheHandler } from '../lib/cache-handlers/types';
```

No file outside `dist/server/**` re-exports them. `dist/server/lib/cache-handlers/` contains `types.d.ts`, `default.d.ts` (`createDefaultCacheHandler(maxSize: number): CacheHandler`) and `default.external.d.ts` (deprecated default export). The `NextConfig['cacheHandlers']` option in `dist/server/config-shared.d.ts` (line 1307) is typed as a map of **file path strings**, so Next never needs to expose the interface through config typing.

Note: `dist/server/lib/incremental-cache/index.d.ts` also declares a class named `CacheHandler`, but that is the legacy ISR `cacheHandler` (singular) API with a different shape (`get(key, ctx)`, `set(key, data, ctx)`, `revalidateTag`). Do not confuse the two.

### 4. The interface as shipped in 16.3.2

`/tmp/next-probe/node_modules/next/dist/server/lib/cache-handlers/types.d.ts` (JSDoc stripped):

```ts
export type Timestamp = number;
export interface CacheEntry {
  value: ReadableStream<Uint8Array>;
  tags: string[];
  stale: number;
  timestamp: Timestamp;
  expire: number;
  revalidate: number;
}
export interface CacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<undefined | CacheEntry>;
  set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<Timestamp>;
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}
```

The file has no imports, so it type-checks standalone (confirmed below with `skipLibCheck: false`).

### 5. Empirical resolution test

Setup: `/tmp/next-types-probe`, `npm i next@16.3.2 typescript@5 @types/node@22` (resolved `typescript@5.9.3`). Script: `/tmp/next-types-probe/run-probes.sh`. Each probe file was checked with `strict: true` under three configs: `module=esnext/moduleResolution=bundler`, `node16/node16`, `nodenext/nodenext`.

| Probe | Import | bundler | node16 | nodenext |
| --- | --- | --- | --- | --- |
| `probe-deep.ts` | `import type { CacheHandler, CacheEntry, Timestamp } from 'next/dist/server/lib/cache-handlers/types'` and implement a full handler | exit 0 | exit 0 | exit 0 |
| `probe-deep-js-ext.ts` | same path with `.js` suffix | exit 0 | exit 0 | exit 0 |
| `probe-default-factory.ts` | `import { createDefaultCacheHandler } from 'next/dist/server/lib/cache-handlers/default'` | exit 0 | exit 0 | exit 0 |
| `probe-config.ts` | `NextConfig` with `cacheHandlers: { default, remote, static, custom }` | exit 0 | exit 0 | exit 0 |
| `probe-public-types.ts` | `import type { CacheHandler } from 'next/types'` | TS2614 | TS2614 | TS2614 |
| `probe-public-cache.ts` | `import type { CacheHandler } from 'next/cache'` | TS2305 | TS2305 | TS2305 |
| `probe-public-root.ts` | `import type { CacheHandler } from 'next'` | TS2614 | TS2614 | TS2614 |

Exact errors:

```
probe-public-types.ts(2,15): error TS2614: Module '"next/types"' has no exported member 'CacheHandler'.
probe-public-cache.ts(2,15): error TS2305: Module '"next/cache"' has no exported member 'CacheHandler'.
probe-public-root.ts(2,15): error TS2614: Module '"next"' has no exported member 'CacheHandler'.
```

Additional check, `probe-deep.ts` under `node16` with `skipLibCheck: false`: exit 0.

### 6. Stability across versions

Script: `/tmp/next-types-probe/fetch-versions.sh` (downloads `npm view next@<v> dist.tarball`, extracts `package.json` and `dist/server/lib/cache-handlers/types.d.ts`).

| Version | `exports` in package.json | `typesVersions` | sha256 of `cache-handlers/types.d.ts` (first 16) |
| --- | --- | --- | --- |
| 15.5.0 | no | no | `d6e73f8010935b7b` |
| 16.0.0 | no | no | `ee8df1cb8d0faaca` |
| 16.1.0 | no | no | `ee8df1cb8d0faaca` |
| 16.2.0 | no | no | `ee8df1cb8d0faaca` |
| 16.3.0 | no | no | `ee8df1cb8d0faaca` |
| 16.3.1 | no | no | `ee8df1cb8d0faaca` |
| 16.3.2 | no | no | `ee8df1cb8d0faaca` |

`diff` of 16.0.0, 16.3.0 and 16.3.1 against 16.3.2: `IDENTICAL`.

`diff` 15.5.0 vs 16.3.2 (summary): 15.5.0 declared a deprecated V1 `CacheHandler` (`expireTags(...tags)`, `receiveExpiredTags(...tags)`), a `CacheHandlerV2` and a `CacheHandlerCompat` union. 16.0.0 removed V1 and the compat union, renamed V2 to `CacheHandler`, changed `getExpiration(...tags: string[])` to `getExpiration(tags: string[])` and replaced `expireTags(...tags)` with `updateTags(tags, durations?)`. Same file path, incompatible shape. The `cacheHandlers` docs page's version table also states `v16.0.0 | cacheHandlers introduced.`

Upstream change frequency of the source file (`gh api repos/vercel/next.js/commits?path=packages/next/src/server/lib/cache-handlers/types.ts`):

```
2025-10-09 e598a4f9 Add new updateTag API and new signature for revalidateTag (#83822)
2025-05-15 0c0262e6 Always pass implicit/soft tags into the `CacheHandler.get` method (#79213)
2025-03-18 84fde91e Update cache handler interface (#76687)
2025-01-08 8ffa6c74 Ensure global cache handlers are used properly (#74626)
2024-11-27 a771ce2f Undeprecate revalidate APIs and rename expire APIs (#73193)
2024-11-05 2f43ba59 [ppr] Resume Data Cache (#72161)
2024-10-19 c228a6e6 Add default cache handler and update tags manifest handling (#71455)
```

Seven edits in its lifetime, none since October 2025 (pre-16.0 GA). Three of them (2025-03, 2025-05, 2025-10) changed method signatures.

### 7. What the official docs say

`docs/01-app/03-api-reference/05-config/01-next-config-js/cacheHandlers.mdx` at tag `v16.3.2` (fetched via `curl` from raw.githubusercontent.com, and via `ctx7 docs /vercel/next.js`):

- Line 74: "A cache handler must implement the [`CacheHandler`](https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/cache-handlers/types.ts) interface with the following methods".
- Line 230: "The [`CacheEntry`](https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/cache-handlers/types.ts) object has the following structure".
- The page contains no `import type ... from 'next/...'` for these types; all examples are untyped JavaScript object literals.

So the documented contract is the source file on the `canary` branch, which is not a versioned, importable surface.

### 8. Is there an `@next/cache-handlers` package?

`npm view @next/cache-handlers` returns 404. The string only appears as `Symbol.for('@next/cache-handlers')` in `dist/server/use-cache/handlers.js` (lines 60-64), a global registration key used by hosting platforms, not a package.

## Recommendation

**Vendor the interface in the library, and guard it with a compile-time contract test against the deep path.** Do not make the deep path the library's public type surface.

Concretely:

1. Declare `CacheHandler`, `CacheEntry` and `Timestamp` in the library's own `src/types.ts` (copy of section 4, with the library's own JSDoc). The library's exported handler class/function is typed against these.
2. Add a type-only contract test (e.g. `src/next-contract.test-d.ts` or a `tsc`-checked file excluded from the build) that imports `next/dist/server/lib/cache-handlers/types` and asserts mutual assignability in both directions:
   ```ts
   import type { CacheHandler as NextCacheHandler, CacheEntry as NextCacheEntry } from 'next/dist/server/lib/cache-handlers/types'
   import type { CacheHandler, CacheEntry } from './types'
   type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
   const _h: Eq<CacheHandler, NextCacheHandler> = true
   const _e: Eq<CacheEntry, NextCacheEntry> = true
   ```
   `next` stays a `peerDependency` plus `devDependency`; the test runs in CI against the pinned dev version and, ideally, a matrix of the supported `peerDependencies` range.
3. Keep `next` out of the library's emitted `.d.ts`. Consumers then never depend on `next/dist/*` transitively, and the library compiles under `bundler`, `node16` and `nodenext` regardless of whether Vercel later adds an `exports` map.

### Trade-offs

| Option | Pros | Cons |
| --- | --- | --- |
| **Import from a public path** | Would be the right answer if it existed. | Does not exist in 16.3.2 (section 5). Not an option today. |
| **Import from deep path `next/dist/server/lib/cache-handlers/types`** | Zero duplication; resolves today under every `moduleResolution` (section 5); stable across all 16.x (section 6). | `dist/` is an unadvertised internal; Next can add an `exports` map in any release and break the import for every consumer of the library's `.d.ts`, not just the library itself. Emitted declarations would reference `next/dist/...`, forcing consumers' `tsc` to resolve it too (and to have `next` installed at type-check time). Any upstream change lands silently as a type error in downstream projects rather than in the library's CI. |
| **Vendor interface + contract test (recommended)** | Library's public types are self-contained; drift against Next is caught in the library's CI, where it can be fixed and released deliberately; works for consumers who type-check without `next` resolvable (monorepos, `paths` aliases). | One ~20-line file duplicated; must bump on the next major (history says the shape moves at majors: 15.5 to 16.0 changed it). The contract test pins the `devDependency` version, so CI should test the upper and lower bounds of the peer range. |

The main risk with the deep path is not patch-release churn (none observed in 16.x) but the lack of any `exports` contract: the path is reachable only because Next has never shipped an `exports` map. Vendoring costs one small file and converts that external risk into a failing test in this repo.
