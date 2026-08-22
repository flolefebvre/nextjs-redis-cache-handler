import { createCacheClient } from "./client.js";
import type { BufferedEntry, StoredEntry } from "./entry-hash.js";
import { entryAge, entryKey, entryTtlSeconds, readEntry, writeEntry } from "./entry-store.js";
import { createReporter, type CacheEvent, type CacheSkipReason } from "./events.js";
import {
  DEFAULT_KEY_PREFIX,
  DEFAULT_MAX_ENTRY_SIZE,
  DEFAULT_MAX_TTL,
  type RedisCacheHandlerOptions,
} from "./options.js";
import { createTagManifest } from "./tag-manifest.js";
import { readTagManifest, writeTagEvents } from "./tag-store.js";
import type { CacheEntry, CacheHandler, Timestamp } from "./types.js";

const STALE_REVALIDATE = -1;

/**
 * What a read of one key came to, before it is flattened into what the interface returns:
 * an Entry to serve, an Entry to serve once more while the wrapper regenerates it, or a
 * miss and why. It maps one to one to the event `onEvent` receives.
 */
type ReadOutcome =
  | { kind: "hit" | "stale"; entry: CacheEntry }
  | { kind: "miss"; reason: "absent" | "expired" | "unavailable" };

/**
 * Build a Cache Handler backed by Redis or Valkey, so that every Instance of a
 * multi-instance deployment reads and writes the same Entries.
 *
 * The returned object is what `cacheHandlers` in `next.config` expects, plus `close()`
 * for the tests and for a host that shuts the handler down itself. No connection is
 * opened until the first operation, nothing is scanned or deleted at startup, and no
 * process signal handler is installed.
 *
 * Neither `get` nor `set` ever rejects: a read that fails is a miss and a write that
 * fails is dropped. Next.js awaits pending writes after a Server Action, so a rejected
 * `set` would fail the user's action over a cache blip. `refreshTags` never rejects
 * either — a rejection would fail every cache read of the request — but until one full
 * read of the Tag manifest has succeeded in this process every `get` is a miss: a miss
 * is slow, serving an Entry a mutation has already dropped is wrong. `updateTags` does
 * reject, so that a lost invalidation fails the Server Action visibly.
 *
 * Every outcome of a `get` and of a `set` is reported to `onEvent`, and every failure to
 * `onError` with the operation it happened in. An Entry the wrapper would read as expired
 * on every read, or one whose value is larger than `maxEntrySize`, is not written at all
 * and is reported as a `skip`.
 */
export function createRedisCacheHandler(
  options: RedisCacheHandlerOptions,
): CacheHandler & { close(): Promise<void> } {
  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const maxTtl = options.maxTtl ?? DEFAULT_MAX_TTL;
  const maxEntrySize = options.maxEntrySize ?? DEFAULT_MAX_ENTRY_SIZE;
  const reporter = createReporter(options);
  const client = createCacheClient(options.url, reporter.fail);
  const pendingSets = new Map<string, Promise<void>>();
  const manifest = createTagManifest();
  let refreshing: Promise<void> | undefined;

  async function store(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void> {
    const entry = await pendingEntry;
    const value = await readStream(entry.value);
    const startedAt = performance.now();
    const skipped = skipReason(entry, value, maxEntrySize);
    if (skipped !== undefined) {
      reporter.emit({
        type: "skip",
        reason: skipped,
        size: value.byteLength,
        key: cacheKey,
        durationMs: performance.now() - startedAt,
      });

      return;
    }

    const age = entryAge(entry.timestamp, Date.now());
    const connected = await client.connected();

    await writeEntry(
      connected,
      entryKey(keyPrefix, cacheKey),
      { ...entry, value },
      age,
      entryTtlSeconds(entry.expire, maxTtl),
    );
    reporter.emit({ type: "set", key: cacheKey, durationMs: performance.now() - startedAt });
  }

  async function load(cacheKey: string): Promise<StoredEntry | undefined> {
    const connected = await client.connected();

    return readEntry(connected, entryKey(keyPrefix, cacheKey));
  }

  async function read(cacheKey: string, softTags: string[]): Promise<ReadOutcome> {
    await pendingSets.get(cacheKey);
    if (manifest.serverNow() === undefined) return { kind: "miss", reason: "unavailable" };

    try {
      const stored = await load(cacheKey);
      if (stored === undefined) return { kind: "miss", reason: "absent" };
      if (stored.expire < 0) return { kind: "miss", reason: "expired" };

      const verdict = manifest.verdictFor(stored.tags, softTags, stored.writeTime);
      if (verdict === "expired") return { kind: "miss", reason: "expired" };

      const stale = verdict === "stale" || isPastRevalidate(stored, Date.now());

      return { kind: stale ? "stale" : "hit", entry: entryOf(stored, stale) };
    } catch (error) {
      reporter.fail(error, "get");

      return { kind: "miss", reason: "unavailable" };
    }
  }

  async function refresh(): Promise<void> {
    const connected = await client.connected();

    manifest.replaceWith(await readTagManifest(connected, keyPrefix));
  }

  return {
    async get(cacheKey: string, softTags: string[]): Promise<undefined | CacheEntry> {
      const startedAt = performance.now();
      const outcome = await read(cacheKey, softTags);
      reporter.emit(eventOf(outcome, cacheKey, performance.now() - startedAt));

      return outcome.kind === "miss" ? undefined : outcome.entry;
    },
    set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void> {
      const inFlight = store(cacheKey, pendingEntry).catch((error: unknown) => {
        reporter.fail(error, "set");
      });
      pendingSets.set(cacheKey, inFlight);

      return inFlight.finally(() => {
        if (pendingSets.get(cacheKey) === inFlight) pendingSets.delete(cacheKey);
      });
    },
    refreshTags(): Promise<void> {
      refreshing ??= refresh()
        .catch((error: unknown) => {
          reporter.fail(error, "refreshTags");
        })
        .finally(() => {
          refreshing = undefined;
        });

      return refreshing;
    },
    getExpiration(): Promise<Timestamp> {
      return Promise.resolve(Infinity);
    },
    async updateTags(tags: string[], durations?: { expire?: number }): Promise<void> {
      if (tags.length === 0) return;

      try {
        const connected = await client.connected();

        await writeTagEvents(connected, keyPrefix, tags, durations, maxTtl);
      } catch (error) {
        reporter.fail(error, "updateTags");

        throw error;
      }
    },
    close(): Promise<void> {
      return client.close();
    },
  };
}

function skipReason(
  entry: CacheEntry,
  value: Uint8Array,
  maxEntrySize: number,
): CacheSkipReason | undefined {
  if (entry.expire <= 0) return "expire-zero";
  if (value.byteLength > maxEntrySize) return "too-large";

  return undefined;
}

function eventOf(outcome: ReadOutcome, key: string, durationMs: number): CacheEvent {
  return outcome.kind === "miss"
    ? { type: "miss", reason: outcome.reason, key, durationMs }
    : { type: outcome.kind, key, durationMs };
}

function isPastRevalidate(stored: StoredEntry, appNow: Timestamp): boolean {
  return appNow > stored.timestamp + stored.revalidate * 1000;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);

  return Buffer.concat(chunks);
}

function entryOf(stored: BufferedEntry, stale: boolean): CacheEntry {
  return {
    value: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(stored.value);
        controller.close();
      },
    }),
    tags: stored.tags,
    stale: stored.stale,
    timestamp: stored.timestamp,
    expire: stored.expire,
    revalidate: stale ? STALE_REVALIDATE : stored.revalidate,
  };
}
