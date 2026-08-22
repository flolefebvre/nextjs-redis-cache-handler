import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { expect, inject, onTestFinished, test } from "vitest";

import { createRedisCacheHandler } from "./redis-cache-handler.js";
import type { CacheEntry } from "./types.js";

const VALUE = Uint8Array.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0xc3, 0x28]);

function freshPrefix(): string {
  return `cache-test:${randomUUID()}:`;
}

function handlerFor(keyPrefix: string, maxTtl?: number) {
  const handler = createRedisCacheHandler({ url: inject("redisUrl"), keyPrefix, maxTtl });
  onTestFinished(() => handler.close());

  return handler;
}

async function serverClient() {
  const client = createClient({ url: inject("redisUrl") });
  client.on("error", () => undefined);
  await client.connect();
  onTestFinished(() => client.close());

  return client;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);

  return Uint8Array.from(Buffer.concat(chunks));
}

function entryOf(overrides: Partial<CacheEntry> = {}): CacheEntry {
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

function timingsOf(entry: CacheEntry): Omit<CacheEntry, "value"> {
  return {
    tags: entry.tags,
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: entry.revalidate,
  };
}

test("an Entry written by set comes back from get unchanged", async () => {
  const handler = handlerFor(freshPrefix());
  const entry = entryOf();

  await handler.set("key", Promise.resolve(entry));
  const hit = await handler.get("key", []);

  expect(hit).toBeDefined();
  expect(timingsOf(hit as CacheEntry)).toEqual(timingsOf(entry));
  expect(await bytesOf((hit as CacheEntry).value)).toEqual(VALUE);
});

test("what one handler writes another handler on the same Key prefix reads", async () => {
  const keyPrefix = freshPrefix();
  const [instanceA, instanceB, elsewhere] = [
    handlerFor(keyPrefix),
    handlerFor(keyPrefix),
    handlerFor(freshPrefix()),
  ];

  await instanceA.set("shared", Promise.resolve(entryOf()));

  expect(await instanceB.get("shared", [])).toBeDefined();
  expect(await elsewhere.get("shared", [])).toBeUndefined();
});

test("set stores one hash under the Entry key, with the Entry's expire as its TTL", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();

  await handler.set("ttl", Promise.resolve(entryOf({ expire: 900 })));

  expect(await server.type(`${keyPrefix}entry:ttl`)).toBe("hash");
  expect(await server.ttl(`${keyPrefix}entry:ttl`)).toBeGreaterThan(898);
  expect(await server.ttl(`${keyPrefix}entry:ttl`)).toBeLessThanOrEqual(900);
});

test("an Entry that should never expire keeps the TTL cap, whichever way Next.js says never", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix, 120);
  const server = await serverClient();

  await handler.set("sentinel", Promise.resolve(entryOf({ expire: 4294967294 })));
  await handler.set("infinite", Promise.resolve(entryOf({ expire: Infinity })));

  expect(await server.ttl(`${keyPrefix}entry:sentinel`)).toBeGreaterThan(118);
  expect(await server.ttl(`${keyPrefix}entry:sentinel`)).toBeLessThanOrEqual(120);
  expect(await server.ttl(`${keyPrefix}entry:infinite`)).toBeGreaterThan(118);
  expect(await server.ttl(`${keyPrefix}entry:infinite`)).toBeLessThanOrEqual(120);
});

test("an Entry longer-lived than the TTL cap is capped", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix, 60);

  await handler.set("capped", Promise.resolve(entryOf({ expire: 3600 })));
  const server = await serverClient();

  expect(await server.ttl(`${keyPrefix}entry:capped`)).toBeLessThanOrEqual(60);
});

test("a negative revalidate is stored and returned unchanged", async () => {
  const handler = handlerFor(freshPrefix());
  const entry = entryOf({ revalidate: -1 });

  await handler.set("stale-entry", Promise.resolve(entry));
  const hit = await handler.get("stale-entry", []);

  expect((hit as CacheEntry).revalidate).toBe(-1);
});

test("an Entry that is already expired is not stored and reads as a miss", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();

  await handler.set("gone", Promise.resolve(entryOf({ expire: -1 })));
  await handler.set("zero", Promise.resolve(entryOf({ expire: 0 })));

  expect(await handler.get("gone", [])).toBeUndefined();
  expect(await handler.get("zero", [])).toBeUndefined();
  expect(await server.exists([`${keyPrefix}entry:gone`, `${keyPrefix}entry:zero`])).toBe(0);
});

test("a get issued while a set for the same key is still pending returns the stored Entry", async () => {
  const handler = handlerFor(freshPrefix());
  const entry = entryOf();
  let complete: (entry: CacheEntry) => void = () => undefined;
  const pendingEntry = new Promise<CacheEntry>((resolve) => {
    complete = resolve;
  });

  const written = handler.set("pending", pendingEntry);
  const read = handler.get("pending", []);
  setTimeout(() => {
    complete(entry);
  }, 50);
  const [, hit] = await Promise.all([written, read]);

  expect(hit).toBeDefined();
  expect(await bytesOf((hit as CacheEntry).value)).toEqual(VALUE);
});

test("a key nobody wrote is a miss", async () => {
  const handler = handlerFor(freshPrefix());

  expect(await handler.get("never-written", [])).toBeUndefined();
});

test("the methods the tag model will own satisfy the interface", async () => {
  const handler = handlerFor(freshPrefix());

  await expect(handler.refreshTags()).resolves.toBeUndefined();
  await expect(handler.updateTags(["posts"])).resolves.toBeUndefined();
  await expect(handler.getExpiration(["posts"])).resolves.toBe(Infinity);
});
