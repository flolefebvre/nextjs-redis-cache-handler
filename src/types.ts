/**
 * A point in time, in milliseconds elapsed since the epoch.
 */
export type Timestamp = number;

/**
 * One cached output: its value, its Explicit tags and its timings.
 *
 * Vendored from Next.js 16.3's `CacheHandler` interface, which Next.js only declares
 * under the internal path `next/dist/server/lib/cache-handlers/types`. The vendored
 * copy is this library's public type surface, so consumers never depend on that path;
 * `src/types.test.ts` fails the typecheck if the two shapes ever diverge.
 */
export interface CacheEntry {
  /**
   * The RSC payload. The stream can error and carry only part of the output, so a
   * handler must decide whether to keep a partial Entry or drop it.
   */
  value: ReadableStream<Uint8Array>;
  /**
   * The Explicit tags attached to the Entry. Soft tags are never in here.
   */
  tags: string[];
  /**
   * How long the Entry stays fresh for the client, in seconds. Not used to compute
   * the Entry's expiration.
   */
  stale: number;
  /**
   * When the Entry's generation started, on the app's clock, in milliseconds.
   */
  timestamp: Timestamp;
  /**
   * How long the Entry may be served for, in seconds. Longer than `revalidate`.
   */
  expire: number;
  /**
   * How long until the Entry should be regenerated, in seconds.
   */
  revalidate: number;
}

/**
 * The object Next.js calls to read, write and invalidate `'use cache'` output: an
 * entry of the `cacheHandlers` map in `next.config`.
 */
export interface CacheHandler {
  /**
   * Read the Entry stored under `cacheKey`, or `undefined` when there is no valid one
   * — including when one of `softTags` is Expired.
   */
  get(cacheKey: string, softTags: string[]): Promise<undefined | CacheEntry>;
  /**
   * Store the Entry for `cacheKey`. The Entry may still be pending when this is
   * called — its value stream may still be written to — so it must be awaited first.
   * A `get` on the same key issued before the pending Entry completes must wait for
   * this `set` to finish and return the stored Entry rather than `undefined`.
   */
  set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>;
  /**
   * Refresh the local copy of the Tag manifest. Called before a request starts, never
   * during one.
   */
  refreshTags(): Promise<void>;
  /**
   * The most recent revalidation time across `tags`, `0` when none was ever
   * revalidated, or `Infinity` to have the Soft tags handed to `get` instead and
   * checked for expiration there.
   */
  getExpiration(tags: string[]): Promise<Timestamp>;
  /**
   * Record that `tags` were made Stale or Expired.
   */
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}
