import { expect, onTestFinished, test, vi } from "vitest";

import {
  entryOf,
  freshPrefix,
  handlerFor,
  opsOf,
  recording,
  serverClient,
  storeBefore,
} from "../tests/handler-harness.js";

const MAX_EXPIRE = 31_536_000;

test("a hit fires one hit event with the key and a non-negative duration", async () => {
  const recorded = recording();
  const handler = handlerFor(freshPrefix(), recorded);
  await storeBefore(handler, "key");
  await handler.refreshTags();
  recorded.events.length = 0;

  await handler.get("key", []);

  expect(recorded.events).toHaveLength(1);
  expect(recorded.events[0]).toMatchObject({ type: "hit", key: "key" });
  expect(recorded.events[0]?.durationMs).toBeGreaterThanOrEqual(0);
});

test("a key that was never written fires one absent miss", async () => {
  const recorded = recording();
  const handler = handlerFor(freshPrefix(), recorded);
  await handler.refreshTags();

  await handler.get("nothing", []);

  expect(recorded.events).toEqual([
    { type: "miss", reason: "absent", key: "nothing", durationMs: expect.any(Number) },
  ]);
});

test("an Entry a tag has expired fires one expired miss", async () => {
  const recorded = recording();
  const handler = handlerFor(freshPrefix(), recorded);
  await storeBefore(handler, "key", { tags: ["posts"] });
  await handler.updateTags(["posts"]);
  await handler.refreshTags();
  recorded.events.length = 0;

  await handler.get("key", []);

  expect(recorded.events).toEqual([
    { type: "miss", reason: "expired", key: "key", durationMs: expect.any(Number) },
  ]);
});

test("an Entry a tag has made stale fires one stale event", async () => {
  const recorded = recording();
  const handler = handlerFor(freshPrefix(), recorded);
  await storeBefore(handler, "key", { tags: ["posts"] });
  await handler.updateTags(["posts"], { expire: MAX_EXPIRE });
  await handler.refreshTags();
  recorded.events.length = 0;

  await handler.get("key", []);

  expect(recorded.events).toEqual([{ type: "stale", key: "key", durationMs: expect.any(Number) }]);
});

test("a read before the Tag manifest was ever read is an unavailable miss, and no error", async () => {
  const recorded = recording();
  const handler = handlerFor(freshPrefix(), recorded);

  expect(await handler.get("key", [])).toBeUndefined();

  expect(recorded.events).toEqual([
    { type: "miss", reason: "unavailable", key: "key", durationMs: expect.any(Number) },
  ]);
  expect(recorded.errors).toEqual([]);
});

test("an event hook that throws leaves the read's result untouched", async () => {
  const handler = handlerFor(freshPrefix(), {
    onEvent: () => {
      throw new Error("hook");
    },
  });
  await storeBefore(handler, "key");
  await handler.refreshTags();

  expect(await handler.get("key", [])).toBeDefined();
  expect(await handler.get("other", [])).toBeUndefined();
});

test("a read that fails reports the failure as get, and still misses", async () => {
  const keyPrefix = freshPrefix();
  const recorded = recording();
  const handler = handlerFor(keyPrefix, recorded);
  const server = await serverClient();
  await handler.refreshTags();
  await server.set(`${keyPrefix}entry:key`, "not a hash");

  expect(await handler.get("key", [])).toBeUndefined();

  expect(opsOf(recorded.errors)).toEqual(["get"]);
  expect(recorded.events).toEqual([
    { type: "miss", reason: "unavailable", key: "key", durationMs: expect.any(Number) },
  ]);
});

test("a manifest read that fails reports the failure as refreshTags", async () => {
  const keyPrefix = freshPrefix();
  const recorded = recording();
  const handler = handlerFor(keyPrefix, recorded);
  const server = await serverClient();
  await server.set(`${keyPrefix}{tags}`, "not a hash");

  await expect(handler.refreshTags()).resolves.toBeUndefined();

  expect(opsOf(recorded.errors)).toEqual(["refreshTags"]);
});

test("with no error hook, one failure reaches console.error once", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  onTestFinished(() => logged.mockRestore());
  await server.set(`${keyPrefix}{tags}`, "not a hash");

  await handler.refreshTags();

  expect(logged).toHaveBeenCalledTimes(1);
  expect(logged.mock.calls[0]).toContain("refreshTags");
});

test("a tag write that fails reports the failure as updateTags, and still rejects", async () => {
  const keyPrefix = freshPrefix();
  const recorded = recording();
  const handler = handlerFor(keyPrefix, recorded);
  const server = await serverClient();
  await server.set(`${keyPrefix}{tags}`, "not a hash");

  await expect(handler.updateTags(["posts"])).rejects.toThrow();

  expect(opsOf(recorded.errors)).toEqual(["updateTags"]);
});

test("a write that fails reports the failure as set, and set still resolves", async () => {
  const keyPrefix = freshPrefix();
  const recorded = recording();
  const handler = handlerFor(keyPrefix, recorded);
  const server = await serverClient();
  await server.set(`${keyPrefix}entry:key`, "not a hash");

  await expect(handler.set("key", Promise.resolve(entryOf()))).resolves.toBeUndefined();

  expect(opsOf(recorded.errors)).toEqual(["set"]);
  expect(recorded.events).toEqual([]);
});
