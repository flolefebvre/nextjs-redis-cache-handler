import type { CacheErrorHook, CacheEventHook } from "./events.js";

/**
 * How one app's Cache Handler talks to its store. `url` is the only required value;
 * every other option has a default. Later versions add the injected client and the
 * deadlines the README documents.
 */
export interface RedisCacheHandlerOptions {
  /** `redis://` or `rediss://` connection URL of the server every Instance shares. */
  url: string;
  /**
   * The Key prefix: the Redis key namespace holding this app's Entries and Tag
   * manifest, used verbatim. Two apps on one server must never share it.
   */
  keyPrefix?: string;
  /**
   * The cap, in seconds, on every Entry's TTL. The "never" sentinel Next.js sends for
   * an Entry that should not expire always clamps to it.
   */
  maxTtl?: number;
  /**
   * The cap, in bytes, on the buffered value of one Entry. A larger Entry is not stored
   * and is reported as a `skip` with `reason: 'too-large'`, so that the scope renders
   * uncached instead of loading the store with output it should not hold.
   */
  maxEntrySize?: number;
  /** Called once per `get` and per `set` outcome. Exceptions are caught and ignored. */
  onEvent?: CacheEventHook;
  /**
   * Called once per failure, with the operation it happened in. Defaults to
   * `console.error` when neither this hook nor `debug` is given. Exceptions are caught
   * and ignored.
   */
  onError?: CacheErrorHook;
  /**
   * Log every event and every failure to the console, one line each, stamped with the
   * Next.js phase. Coexists with `onEvent` and `onError`: both run.
   */
  debug?: boolean;
}

/** The Key prefix used when `keyPrefix` is not given. */
export const DEFAULT_KEY_PREFIX = "next-cache:";

/** The TTL cap used when `maxTtl` is not given: 30 days, the `max` profile's window. */
export const DEFAULT_MAX_TTL = 2_592_000;

/** The Entry size cap used when `maxEntrySize` is not given: 1 MiB. */
export const DEFAULT_MAX_ENTRY_SIZE = 1_048_576;
