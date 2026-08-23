import type { CacheClient } from "./client.js";
import type { CacheErrorHook, CacheEventHook } from "./events.js";

/**
 * How one app's Cache Handler talks to its store. Exactly one of `url` and `client` is
 * required; every other option has a default. Every value is checked when the factory is
 * called, so that a misconfiguration is a throw at startup rather than a cache that
 * quietly serves nothing.
 */
export interface RedisCacheHandlerOptions {
  /**
   * `redis://` or `rediss://` connection URL of the server every Instance shares. The
   * handler creates the client, tunes it, and quits it on `close()`. Exclusive with
   * `client`: exactly one of the two is required.
   */
  url?: string;
  /**
   * A node-redis client the caller created and owns — standalone, Sentinel
   * (`createSentinel`) or Cluster (`createCluster`) — whatever its RESP version, its TLS
   * socket or its own tuning: the escape hatch for a connection this library's own
   * options cannot express, and the way to point the handler at a Sentinel deployment or
   * a Cluster. It is used exactly as given — never connected, never quit, and `close()`
   * leaves it open — so the caller connects it and tunes it themselves. Exclusive with
   * `url`: exactly one of the two is required.
   *
   * On Cluster, the Tag manifest, its log and the Handler clock share one slot through
   * the hash tag in their name, and every Entry is routed by its own key, so no operation
   * is ever cross-slot.
   *
   * A client configured to read replicas — `replicaPoolSize` on a Sentinel, `useReplicas`
   * on a Cluster — makes every Entry read lag replication: the one command an Entry is
   * read with is a read-only one, which such a client routes to a replica, so a `get`
   * right after a `set` misses and the scope is rendered again. It is never a hit on an
   * Entry a mutation replaced: the Tag manifest is read through the script channel, which
   * is always the master, and an Entry is judged by its own Write time against it. Leave
   * replica reads off for the handler's client.
   *
   * One caveat on Sentinel. The handler reads the whole Tag manifest again when the
   * connection under it was rebuilt, because the server behind a rebuilt connection may be
   * a different one — restarted empty, restored from an older dataset — whose event log no
   * longer holds what the handler's watermark assumes. A standalone client names that
   * moment `reconnecting` and a Cluster client names it `node-reconnecting`; a Sentinel
   * client names it not at all, so it is counted on `topology-change` and `client-error`
   * instead.
   *
   * A connection rebuilt to the same master is therefore not counted, and needs no full
   * read: the incremental read resumes from the watermark, and an event written while the
   * socket was down is above it and comes back with the next `refreshTags`. A failover is
   * counted, through the `topology-change` the client emits for it. What is left uncounted
   * is a master that comes back with a different dataset without a failover — restarted
   * empty inside the Sentinel's `down-after-milliseconds`, say — where the handler keeps
   * the manifest it already had: it then over-invalidates and never under-invalidates,
   * since the Entries that manifest protects were on the dataset that was lost.
   */
  client?: CacheClient;
  /**
   * The Key prefix: the Redis key namespace holding this app's Entries and Tag
   * manifest, used verbatim. Two apps on one server must never share it.
   */
  keyPrefix?: string;
  /**
   * The deadline, in milliseconds, on every awaited `get`, `set`, `getExpiration` and
   * `refreshTags`: past it the operation gives up, so that a slow store never holds a
   * request longer than this.
   */
  operationTimeout?: number;
  /**
   * The total budget, in milliseconds, `updateTags` retries within before it throws. A
   * lost invalidation would leave every Instance serving output the mutation replaced,
   * so the attempts are spread over this budget with an exponential backoff, each one
   * bounded by `operationTimeout` or by what is left of the budget, whichever is
   * smaller. Past it the call rejects, having reported once through `onError` — and it
   * rejects before it, the same way, on a reply error retrying cannot fix, a `WRONGTYPE`
   * on a corrupted Tag manifest key or a `NOPERM` from an ACL among them.
   */
  updateTagsTimeout?: number;
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
   * Called once per failure, with the operation it happened in. A failing `updateTags`
   * calls it once, on the failure its retries ended with, never once per attempt.
   * `connect` is every failure outside an operation, on the three kinds of client: the
   * `error` of a standalone client, the `client-error` a Sentinel client lets the failure
   * of one of its node connections out as, and the `node-error` a Cluster client emits for
   * the node whose socket failed — the last two reported as an `Error` naming that node.
   * Defaults to `console.error` when neither this hook nor `debug` is given. Exceptions
   * are caught and ignored.
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

/** The operation deadline used when `operationTimeout` is not given: 1 s. */
export const DEFAULT_OPERATION_TIMEOUT = 1_000;

/** The retry budget used when `updateTagsTimeout` is not given: 5 s. */
export const DEFAULT_UPDATE_TAGS_TIMEOUT = 5_000;

const URL_PROTOCOLS = ["redis:", "rediss:"];

const CLIENT_METHODS = ["withTypeMapping", "on", "off"];

const KNOWN_OPTIONS = [
  "url",
  "client",
  "keyPrefix",
  "operationTimeout",
  "updateTagsTimeout",
  "maxTtl",
  "maxEntrySize",
  "onEvent",
  "onError",
  "debug",
];

/**
 * Where the client of one handler object comes from: a URL the handler dials itself, or
 * a client the caller owns. The two are exclusive, which is why they are one value here
 * and not two optional fields the rest of the library would have to check again.
 */
export type CacheConnection = { url: string } | { client: CacheClient };

/**
 * One handler object's options, checked and defaulted: what the handler reads. Nothing
 * downstream falls back to a default of its own, so a default lives in exactly one place.
 */
export interface ResolvedCacheOptions {
  connection: CacheConnection;
  keyPrefix: string;
  operationTimeout: number;
  updateTagsTimeout: number;
  maxTtl: number;
  maxEntrySize: number;
  onEvent?: CacheEventHook;
  onError?: CacheErrorHook;
  debug: boolean;
}

/**
 * Check one options object and fill in every default, or throw naming the option at
 * fault.
 *
 * This is the only validation in the library: the factory calls it before anything else
 * so that a bad value is a synchronous throw where the handler is configured, not a
 * failure on the first request of the first Instance to serve traffic. The argument is
 * read, never written to.
 */
export function resolveOptions(options: RedisCacheHandlerOptions): ResolvedCacheOptions {
  if (typeof options !== "object" || options === null) {
    throw new Error("options must be an object");
  }

  rejectUnknownKeys(options);

  return {
    connection: connectionOf(options),
    keyPrefix: nonEmptyString(options.keyPrefix, "keyPrefix", DEFAULT_KEY_PREFIX),
    operationTimeout: positiveInteger(
      options.operationTimeout,
      "operationTimeout",
      DEFAULT_OPERATION_TIMEOUT,
    ),
    updateTagsTimeout: positiveInteger(
      options.updateTagsTimeout,
      "updateTagsTimeout",
      DEFAULT_UPDATE_TAGS_TIMEOUT,
    ),
    maxTtl: positiveInteger(options.maxTtl, "maxTtl", DEFAULT_MAX_TTL),
    maxEntrySize: positiveInteger(options.maxEntrySize, "maxEntrySize", DEFAULT_MAX_ENTRY_SIZE),
    onEvent: hook(options.onEvent, "onEvent"),
    onError: hook(options.onError, "onError"),
    debug: boolean(options.debug, "debug"),
  };
}

function rejectUnknownKeys(options: RedisCacheHandlerOptions): void {
  for (const key of Object.keys(options)) {
    if (!KNOWN_OPTIONS.includes(key)) throw new Error(`unknown option \`${key}\``);
  }
}

function connectionOf(options: RedisCacheHandlerOptions): CacheConnection {
  const url = options.url === undefined ? undefined : redisUrl(options.url);
  const client = options.client === undefined ? undefined : redisClient(options.client);

  if (url !== undefined && client !== undefined) {
    throw new Error("exactly one of `url` and `client` is required, both were given");
  }
  if (url !== undefined) return { url };
  if (client !== undefined) return { client };

  throw new Error("exactly one of `url` and `client` is required, neither was given");
}

function redisUrl(value: unknown): string {
  if (typeof value === "string" && URL_PROTOCOLS.includes(protocolOf(value))) return value;

  throw new Error("`url` must be a `redis://` or `rediss://` connection string");
}

function protocolOf(value: string): string {
  return URL.canParse(value) ? new URL(value).protocol : "";
}

function redisClient(value: unknown): CacheClient {
  if (isRecord(value) && CLIENT_METHODS.every((method) => typeof value[method] === "function")) {
    return value as unknown as CacheClient;
  }

  throw new Error("`client` must be a node-redis client");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown, option: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.length > 0) return value;

  throw new Error(`\`${option}\` must be a non-empty string`);
}

function positiveInteger(value: unknown, option: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;

  throw new Error(`\`${option}\` must be a positive integer`);
}

function hook<Hook>(value: Hook | undefined, option: string): Hook | undefined {
  if (value === undefined || typeof value === "function") return value;

  throw new Error(`\`${option}\` must be a function`);
}

function boolean(value: unknown, option: string): boolean {
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;

  throw new Error(`\`${option}\` must be a boolean`);
}
