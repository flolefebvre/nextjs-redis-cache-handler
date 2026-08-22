import { expect, test } from "vitest";

import {
  VALUE,
  bytesOf,
  entryOf,
  freshPrefix,
  handlerFor,
  recording,
  serverClient,
  timingsOf,
} from "../tests/handler-harness.js";
import type { CacheEntry } from "./types.js";

const SHORT_TIMEOUT = 200;

test("an Entry written by set comes back from get unchanged", async () => {
  const handler = handlerFor(freshPrefix());
  const entry = entryOf();
  await handler.refreshTags();

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
  await Promise.all([instanceB.refreshTags(), elsewhere.refreshTags()]);

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
  const handler = handlerFor(keyPrefix, { maxTtl: 120 });
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
  const handler = handlerFor(keyPrefix, { maxTtl: 60 });

  await handler.set("capped", Promise.resolve(entryOf({ expire: 3600 })));
  const server = await serverClient();

  expect(await server.ttl(`${keyPrefix}entry:capped`)).toBeLessThanOrEqual(60);
});

test("a TTL is what is left of the Entry's lifetime at its Write time, cap included", async () => {
  const keyPrefix = freshPrefix();
  const [handler, capped] = [handlerFor(keyPrefix), handlerFor(keyPrefix, { maxTtl: 120 })];
  const server = await serverClient();

  await handler.set("aged", Promise.resolve(entryOf({ timestamp: Date.now() - 895_000 })));
  await capped.set(
    "at-cap",
    Promise.resolve(entryOf({ expire: Infinity, timestamp: Date.now() - 115_000 })),
  );

  expect(await server.ttl(`${keyPrefix}entry:aged`)).toBeGreaterThan(1);
  expect(await server.ttl(`${keyPrefix}entry:aged`)).toBeLessThanOrEqual(5);
  expect(await server.ttl(`${keyPrefix}entry:at-cap`)).toBeGreaterThan(1);
  expect(await server.ttl(`${keyPrefix}entry:at-cap`)).toBeLessThanOrEqual(5);
});

test("an Entry as old as its expire is not stored and reads as a miss", async () => {
  const keyPrefix = freshPrefix();
  const recorded = recording();
  const handler = handlerFor(keyPrefix, recorded.hooks);
  const server = await serverClient();
  await handler.refreshTags();

  await handler.set(
    "spent",
    Promise.resolve(entryOf({ expire: 900, timestamp: Date.now() - 900_000 })),
  );

  expect(recorded.events).toEqual([
    {
      type: "skip",
      reason: "too-old",
      size: VALUE.byteLength,
      key: "spent",
      durationMs: expect.any(Number),
    },
  ]);
  expect(await server.exists(`${keyPrefix}entry:spent`)).toBe(0);
  expect(await handler.get("spent", [])).toBeUndefined();
});

test("an Entry as old as the TTL cap is not stored either", async () => {
  const keyPrefix = freshPrefix();
  const recorded = recording();
  const handler = handlerFor(keyPrefix, { ...recorded.hooks, maxTtl: 60 });
  const server = await serverClient();

  await handler.set(
    "capped",
    Promise.resolve(entryOf({ expire: 3600, timestamp: Date.now() - 70_000 })),
  );

  expect(recorded.events).toEqual([
    {
      type: "skip",
      reason: "too-old",
      size: VALUE.byteLength,
      key: "capped",
      durationMs: expect.any(Number),
    },
  ]);
  expect(await server.exists(`${keyPrefix}entry:capped`)).toBe(0);
});

test("a negative revalidate is stored and returned unchanged", async () => {
  const handler = handlerFor(freshPrefix());
  const entry = entryOf({ revalidate: -1 });
  await handler.refreshTags();

  await handler.set("stale-entry", Promise.resolve(entry));
  const hit = await handler.get("stale-entry", []);

  expect((hit as CacheEntry).revalidate).toBe(-1);
});

test("an Entry that is already expired is not stored and reads as a miss", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();
  await handler.refreshTags();

  await handler.set("gone", Promise.resolve(entryOf({ expire: -1 })));
  await handler.set("zero", Promise.resolve(entryOf({ expire: 0 })));

  expect(await handler.get("gone", [])).toBeUndefined();
  expect(await handler.get("zero", [])).toBeUndefined();
  expect(await server.exists([`${keyPrefix}entry:gone`, `${keyPrefix}entry:zero`])).toBe(0);
});

test("a get issued while a set for the same key is still pending returns the stored Entry", async () => {
  const handler = handlerFor(freshPrefix());
  const entry = entryOf();
  await handler.refreshTags();
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

test("a get waits out a render longer than the deadline instead of timing out", async () => {
  const recorded = recording();
  const handler = handlerFor(freshPrefix(), {
    operationTimeout: SHORT_TIMEOUT,
    ...recorded.hooks,
  });
  await handler.refreshTags();
  const rendering = new Promise<CacheEntry>((resolve) => {
    setTimeout(() => {
      resolve(entryOf());
    }, SHORT_TIMEOUT * 2);
  });

  const written = handler.set("slow-render", rendering);
  const read = handler.get("slow-render", []);
  const [, hit] = await Promise.all([written, read]);

  expect(hit).toBeDefined();
  expect(await bytesOf((hit as CacheEntry).value)).toEqual(VALUE);
  expect(recorded.events.map((event) => event.type)).not.toContain("miss");
  expect(recorded.errors).toEqual([]);
});

test("a key nobody wrote is a miss", async () => {
  const handler = handlerFor(freshPrefix());
  await handler.refreshTags();

  expect(await handler.get("never-written", [])).toBeUndefined();
});
