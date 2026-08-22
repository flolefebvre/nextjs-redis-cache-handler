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

/**
 * How long has passed since it was called, in milliseconds, on the monotonic clock: what
 * every duration a test measures goes through. A host whose wall clock steps backwards
 * mid-test — an NTP correction, a virtual machine resyncing — makes `Date.now()` hand
 * back an elapsed time that is short by the step, negative ones included, which fails a
 * timing assertion the code under test never broke.
 */
export function stopwatch(): () => number {
  const startedAt = performance.now();

  return (): number => performance.now() - startedAt;
}
