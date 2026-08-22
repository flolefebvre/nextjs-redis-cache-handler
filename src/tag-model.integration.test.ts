import { expect, test } from "vitest";

import { entryOf, freshPrefix, handlerFor, serverClient } from "../tests/handler-harness.js";
import type { CacheEntry } from "./types.js";

test("a tag another Instance expired makes the Entry a miss on the next request", async () => {
  const keyPrefix = freshPrefix();
  const [instanceA, instanceB] = [handlerFor(keyPrefix), handlerFor(keyPrefix)];
  await instanceB.refreshTags();

  await instanceA.set("posts", Promise.resolve(entryOf({ tags: ["posts"] })));
  await instanceA.updateTags(["posts"]);
  await instanceB.refreshTags();

  expect(await instanceB.get("posts", [])).toBeUndefined();
});

test("an Instance that has not read the Tag manifest yet misses, and still writes", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();

  await handler.set("written", Promise.resolve(entryOf()));

  expect(await handler.get("written", [])).toBeUndefined();
  expect(await server.exists(`${keyPrefix}entry:written`)).toBe(1);
  await handler.refreshTags();
  expect(await handler.get("written", [])).toBeDefined();
});

test("updating no tag at all touches nothing on the server", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();

  await handler.updateTags([]);

  expect(await server.keys(`${keyPrefix}*`)).toEqual([]);
});

test("a tag event leaves exactly the two Tag manifest keys under the Key prefix", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();

  await handler.updateTags(["posts", "post:1"]);

  expect((await server.keys(`${keyPrefix}*`)).sort()).toEqual([
    `${keyPrefix}{tags}`,
    `${keyPrefix}{tags}:log`,
  ]);
  expect(await server.type(`${keyPrefix}{tags}`)).toBe("hash");
  expect(await server.type(`${keyPrefix}{tags}:log`)).toBe("zset");
});

test("concurrent refreshes of one handler object share a single read", async () => {
  const keyPrefix = freshPrefix();
  const [instanceA, instanceB] = [handlerFor(keyPrefix), handlerFor(keyPrefix)];

  await instanceA.set("posts", Promise.resolve(entryOf({ tags: ["posts"] })));
  await instanceA.updateTags(["posts"]);
  await Promise.all([instanceB.refreshTags(), instanceB.refreshTags(), instanceB.refreshTags()]);

  expect(await instanceB.get("posts", [])).toBeUndefined();
});

test("an Entry written after the tag event is served", async () => {
  const keyPrefix = freshPrefix();
  const [instanceA, instanceB] = [handlerFor(keyPrefix), handlerFor(keyPrefix)];

  await instanceA.updateTags(["posts"]);
  await instanceA.set("posts", Promise.resolve(entryOf({ tags: ["posts"] })));
  await instanceB.refreshTags();

  const hit = await instanceB.get("posts", []);

  expect(hit).toBeDefined();
  expect((hit as CacheEntry).revalidate).toBe(60);
});
