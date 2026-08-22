/**
 * How one app's Cache Handler talks to its store. `url` is the only required value;
 * every other option has a default. Later versions add the injected client, the
 * deadlines, the limits and the hooks the README documents.
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
}

/** The Key prefix used when `keyPrefix` is not given. */
export const DEFAULT_KEY_PREFIX = "next-cache:";

/** The TTL cap used when `maxTtl` is not given: 30 days, the `max` profile's window. */
export const DEFAULT_MAX_TTL = 2_592_000;
