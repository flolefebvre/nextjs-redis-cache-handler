import { expect, test } from "vitest";

import {
  VALUE,
  bytesOf,
  entryOf,
  freshPrefix,
  handlerFor,
  serverClient,
  timingsOf,
} from "../tests/handler-harness.js";
import type { CacheEntry } from "./types.js";

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

test("a key nobody wrote is a miss", async () => {
  const handler = handlerFor(freshPrefix());
  await handler.refreshTags();

  expect(await handler.get("never-written", [])).toBeUndefined();
});
