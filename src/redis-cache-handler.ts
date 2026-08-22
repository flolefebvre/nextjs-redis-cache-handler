import { createCacheClient } from "./client.js";
import type { BufferedEntry, StoredEntry } from "./entry-hash.js";
import { entryKey, entryTtlSeconds, readEntry, writeEntry } from "./entry-store.js";
import { DEFAULT_KEY_PREFIX, DEFAULT_MAX_TTL, type RedisCacheHandlerOptions } from "./options.js";
import type { CacheEntry, CacheHandler, Timestamp } from "./types.js";

/**
 * Build a Cache Handler backed by Redis or Valkey, so that every Instance of a
 * multi-instance deployment reads and writes the same Entries.
 *
 * The returned object is what `cacheHandlers` in `next.config` expects, plus `close()`
 * for the tests and for a host that shuts the handler down itself. No connection is
 * opened until the first operation, nothing is scanned or deleted at startup, and no
 * process signal handler is installed.
 */
export function createRedisCacheHandler(
  options: RedisCacheHandlerOptions,
): CacheHandler & { close(): Promise<void> } {
  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const maxTtl = options.maxTtl ?? DEFAULT_MAX_TTL;
  const client = createCacheClient(options.url);
  const pendingSets = new Map<string, Promise<void>>();

  async function store(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void> {
    const entry = await pendingEntry;
    const value = await readStream(entry.value);
    if (entry.expire <= 0) return;

    const age = Date.now() - entry.timestamp;
    const connected = await client.connected();

    await writeEntry(
      connected,
      entryKey(keyPrefix, cacheKey),
      { ...entry, value },
      age,
      entryTtlSeconds(entry.expire, maxTtl),
    );
  }

  async function load(cacheKey: string): Promise<StoredEntry | undefined> {
    const connected = await client.connected();

    return readEntry(connected, entryKey(keyPrefix, cacheKey));
  }

  return {
    async get(cacheKey: string): Promise<undefined | CacheEntry> {
      await pendingSets.get(cacheKey)?.catch(() => undefined);

      try {
        const stored = await load(cacheKey);
        if (stored === undefined || stored.expire < 0) return undefined;

        return entryOf(stored);
      } catch {
        return undefined;
      }
    },
    set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void> {
      const inFlight = store(cacheKey, pendingEntry);
      pendingSets.set(cacheKey, inFlight);

      return inFlight.finally(() => {
        if (pendingSets.get(cacheKey) === inFlight) pendingSets.delete(cacheKey);
      });
    },
    refreshTags(): Promise<void> {
      return Promise.resolve();
    },
    getExpiration(): Promise<Timestamp> {
      return Promise.resolve(Infinity);
    },
    updateTags(): Promise<void> {
      return Promise.resolve();
    },
    close(): Promise<void> {
      return client.close();
    },
  };
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);

  return Buffer.concat(chunks);
}

function entryOf(stored: BufferedEntry): CacheEntry {
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
    revalidate: stored.revalidate,
  };
}
