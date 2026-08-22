import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { inject, onTestFinished } from "vitest";

import { createRedisCacheHandler } from "../src/redis-cache-handler.js";
import type { CacheEntry, CacheHandler } from "../src/types.js";

/** A value with bytes no UTF-8 decoder would give back, as an RSC payload has. */
export const VALUE = Uint8Array.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0xc3, 0x28]);

/** A Key prefix no other test uses, so that tests never clean anything up. */
export function freshPrefix(): string {
  return `cache-test:${randomUUID()}:`;
}

/** One Instance's handler object, closed when the test ends. */
export function handlerFor(
  keyPrefix: string,
  maxTtl?: number,
): ReturnType<typeof createRedisCacheHandler> {
  const handler = createRedisCacheHandler({ url: inject("redisUrl"), keyPrefix, maxTtl });
  onTestFinished(() => handler.close());

  return handler;
}

/** Two Instances of one app: two handler objects on one fresh Key prefix. */
export function instancePair(): {
  keyPrefix: string;
  instanceA: ReturnType<typeof handlerFor>;
  instanceB: ReturnType<typeof handlerFor>;
} {
  const keyPrefix = freshPrefix();

  return { keyPrefix, instanceA: handlerFor(keyPrefix), instanceB: handlerFor(keyPrefix) };
}

/** A plain client on the same server, to observe what the handler wrote. */
export async function serverClient() {
  const client = createClient({ url: inject("redisUrl") });
  client.on("error", () => undefined);
  await client.connect();
  onTestFinished(() => client.close());

  return client;
}

/** The value of an Entry, as the one-chunk stream Next.js hands `set`. */
export function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** The bytes a returned Entry streams back. */
export async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);

  return Uint8Array.from(Buffer.concat(chunks));
}

/**
 * A real pause long enough for the server clock to move on. Tag events and Write times
 * are compared strictly, so a test that means "before" must not land on the same
 * millisecond.
 */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** An Entry as Next.js would hand it to `set`, with the given overrides. */
export function entryOf(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    value: streamOf(VALUE),
    tags: ["posts", "post:1"],
    stale: 300,
    timestamp: Date.now(),
    expire: 900,
    revalidate: 60,
    ...overrides,
  };
}

/**
 * An Entry stored by one Instance, with the clock moved on afterwards so that a tag event
 * issued next is unambiguously later than the Entry's Write time.
 */
export async function storeBefore(
  instance: CacheHandler,
  cacheKey: string,
  overrides: Partial<CacheEntry> = {},
): Promise<void> {
  await instance.set(cacheKey, Promise.resolve(entryOf(overrides)));
  await tick();
}

/** What one Instance reads for `cacheKey` once it has taken in the latest tag events. */
export async function readAfterRefresh(
  instance: CacheHandler,
  cacheKey: string,
  softTags: string[] = [],
): Promise<CacheEntry | undefined> {
  await instance.refreshTags();

  return instance.get(cacheKey, softTags);
}

/** Everything a returned Entry carries besides its value. */
export function timingsOf(entry: CacheEntry): Omit<CacheEntry, "value"> {
  return {
    tags: entry.tags,
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: entry.revalidate,
  };
}
