import { expect, test } from "vitest";

import {
  entryOf,
  freshPrefix,
  handlerFor,
  instancePair,
  serverClient,
  storeBefore,
  tick,
  timingsOf,
} from "../tests/handler-harness.js";
import type { CacheEntry } from "./types.js";

test("a tag another Instance expired makes the Entry a miss on the next request", async () => {
  const { instanceA, instanceB } = instancePair();
  await instanceB.refreshTags();

  await storeBefore(instanceA, "posts", { tags: ["posts"] });
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
  const { instanceA, instanceB } = instancePair();

  await storeBefore(instanceA, "posts", { tags: ["posts"] });
  await instanceA.updateTags(["posts"]);
  await Promise.all([instanceB.refreshTags(), instanceB.refreshTags(), instanceB.refreshTags()]);

  expect(await instanceB.get("posts", [])).toBeUndefined();
});

test("an Entry written after the tag event is served", async () => {
  const { instanceA, instanceB } = instancePair();

  await instanceA.updateTags(["posts"]);
  await tick();
  await instanceA.set("posts", Promise.resolve(entryOf({ tags: ["posts"] })));
  await instanceB.refreshTags();

  const hit = await instanceB.get("posts", []);

  expect(hit).toBeDefined();
  expect((hit as CacheEntry).revalidate).toBe(60);
});

test("a tag revalidated for max is served once more, with its other timings unchanged", async () => {
  const { instanceA, instanceB } = instancePair();
  const entry = entryOf({ tags: ["posts"] });

  await instanceA.set("posts", Promise.resolve(entry));
  await tick();
  await instanceA.updateTags(["posts"], { expire: 31536000 });
  await instanceB.refreshTags();

  const hit = (await instanceB.get("posts", [])) as CacheEntry;

  expect(hit).toBeDefined();
  expect(timingsOf(hit)).toEqual({ ...timingsOf(entry), revalidate: -1 });
});

test("a tag expired now, however Next.js says it, is an immediate miss", async () => {
  const { instanceA, instanceB } = instancePair();

  await instanceA.set("zero", Promise.resolve(entryOf({ tags: ["zero"] })));
  await storeBefore(instanceA, "legacy", { tags: ["legacy"] });
  await instanceA.updateTags(["zero"], { expire: 0 });
  await instanceA.updateTags(["legacy"]);
  await instanceB.refreshTags();

  expect(await instanceB.get("zero", [])).toBeUndefined();
  expect(await instanceB.get("legacy", [])).toBeUndefined();
});

test("durations without an expire make the tag Stale and leave its expiration where it was", async () => {
  const { instanceA, instanceB } = instancePair();

  await storeBefore(instanceA, "posts", { tags: ["posts"] });
  await instanceA.updateTags(["posts"], { expire: 31536000 });
  await instanceA.updateTags(["posts"], {});
  await instanceB.refreshTags();

  const hit = (await instanceB.get("posts", [])) as CacheEntry;

  expect(hit).toBeDefined();
  expect(hit.revalidate).toBe(-1);
});

test("a Soft tag expired elsewhere makes the Entry miss, and is never stored on it", async () => {
  const { instanceA, instanceB } = instancePair();
  const softTags = ["_N_T_/layout", "_N_T_/blog"];

  await instanceA.set("page", Promise.resolve(entryOf({ tags: ["posts"] })));
  await instanceB.refreshTags();
  const before = (await instanceB.get("page", softTags)) as CacheEntry;
  await tick();
  await instanceA.updateTags(["_N_T_/blog"]);
  await instanceB.refreshTags();

  expect(before.tags).toEqual(["posts"]);
  expect(await instanceB.get("page", softTags)).toBeUndefined();
  expect(await instanceB.get("page", [])).toBeDefined();
});

test("an outer Entry carrying an inner scope's tag misses when that inner tag is expired", async () => {
  const { instanceA, instanceB } = instancePair();

  await storeBefore(instanceA, "outer", { tags: ["outer", "inner"] });
  await instanceA.updateTags(["inner"]);
  await instanceB.refreshTags();

  expect(await instanceB.get("outer", [])).toBeUndefined();
});

test("an Entry claiming a generation start in the future is stamped no later than the server clock", async () => {
  const { instanceA, instanceB } = instancePair();
  const ahead = entryOf({ tags: ["posts"], timestamp: Date.now() + 5_000 });

  await instanceA.set("skewed", Promise.resolve(ahead));
  await tick();
  await instanceA.updateTags(["posts"]);
  await instanceB.refreshTags();

  expect(await instanceB.get("skewed", [])).toBeUndefined();
});

test("an Entry whose render was running when the tag event landed is dropped", async () => {
  const { instanceA, instanceB } = instancePair();
  const started = Date.now() - 5_000;

  await instanceA.updateTags(["posts"]);
  await instanceA.set("slow", Promise.resolve(entryOf({ tags: ["posts"], timestamp: started })));
  await instanceB.refreshTags();

  expect(await instanceB.get("slow", [])).toBeUndefined();
});

test("an Entry whose render started after the tag event is served, however long it took", async () => {
  const { instanceA, instanceB } = instancePair();

  await instanceA.updateTags(["posts"]);
  await tick();
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await instanceA.set("slow", Promise.resolve(entryOf({ tags: ["posts"], timestamp: started })));
  await instanceB.refreshTags();

  expect(await instanceB.get("slow", [])).toBeDefined();
});

test("an Entry past its revalidate window is served once more while it is regenerated", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  await handler.refreshTags();
  const entry = entryOf({ timestamp: Date.now() - 120_000, revalidate: 60 });

  await handler.set("aging", Promise.resolve(entry));
  const hit = (await handler.get("aging", [])) as CacheEntry;

  expect(hit).toBeDefined();
  expect(timingsOf(hit)).toEqual({ ...timingsOf(entry), revalidate: -1 });
});

test("getExpiration never asks the wrapper to discard anything", async () => {
  const handler = handlerFor(freshPrefix());

  await expect(handler.getExpiration([])).resolves.toBe(Infinity);
  await expect(handler.getExpiration(["posts", "_N_T_/blog"])).resolves.toBe(Infinity);
});

test("a tag event too old to affect any living Entry is pruned by a later one", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix, 1);
  const server = await serverClient();

  await handler.updateTags(["ancient"]);
  await handler.updateTags(["scheduled"], { expire: 31536000 });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  await handler.updateTags(["recent"]);

  expect((await server.hKeys(`${keyPrefix}{tags}`)).sort()).toEqual(["recent", "scheduled"]);
  expect(await server.zScore(`${keyPrefix}{tags}:log`, "ancient")).toBeNull();
  expect(await server.zScore(`${keyPrefix}{tags}:log`, "scheduled")).not.toBeNull();
});
