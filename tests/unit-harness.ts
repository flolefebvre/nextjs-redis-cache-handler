import type { CacheEntry } from "../src/types.js";

/** True only when the two types are the same one, not merely assignable both ways. */
export type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** The five methods of the `CacheHandler` interface, in the order the tests assert them. */
export const HANDLER_METHODS = ["get", "set", "refreshTags", "getExpiration", "updateTags"];

/** One Entry as `set` receives it: already resolved, its value never read. */
export function entryOf(): Promise<CacheEntry> {
  return Promise.resolve({
    value: new ReadableStream<Uint8Array>(),
    tags: [],
    stale: 0,
    timestamp: Date.now(),
    expire: 900,
    revalidate: 60,
  });
}
