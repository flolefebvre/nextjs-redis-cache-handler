import { expect, onTestFinished, test, vi } from "vitest";

import {
  VALUE,
  entryOf,
  freshPrefix,
  handlerFor,
  opsOf,
  recording,
  serverClient,
  storeBefore,
  streamOf,
} from "../tests/handler-harness.js";
import type { RedisCacheHandlerOptions } from "./options.js";

const MAX_EXPIRE = 31_536_000;

/**
 * A handler whose Tag manifest key holds a string, so that every manifest command it
 * runs fails on the server with a real error.
 */
async function withBrokenManifest(
  overrides: Partial<RedisCacheHandlerOptions>,
): Promise<ReturnType<typeof handlerFor>> {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix, overrides);
  const server = await serverClient();
  await server.set(`${keyPrefix}{tags}`, "not a hash");

  return handler;
}

test("a hit fires one hit event with the key and a non-negative duration", async () => {
  const recorded = recording();
  const handler = handlerFor(freshPrefix(), recorded.hooks);
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
  const handler = handlerFor(freshPrefix(), recorded.hooks);
  await handler.refreshTags();

  await handler.get("nothing", []);

  expect(recorded.events).toEqual([
    { type: "miss", reason: "absent", key: "nothing", durationMs: expect.any(Number) },
  ]);
});

test("an Entry a tag has expired fires one expired miss", async () => {
  const recorded = recording();
  const handler = handlerFor(freshPrefix(), recorded.hooks);
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
  const handler = handlerFor(freshPrefix(), recorded.hooks);
  await storeBefore(handler, "key", { tags: ["posts"] });
  await handler.updateTags(["posts"], { expire: MAX_EXPIRE });
  await handler.refreshTags();
  recorded.events.length = 0;

  await handler.get("key", []);

  expect(recorded.events).toEqual([{ type: "stale", key: "key", durationMs: expect.any(Number) }]);
});

test("a read before the Tag manifest was ever read is an unavailable miss, and no error", async () => {
  const recorded = recording();
  const handler = handlerFor(freshPrefix(), recorded.hooks);

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
  const handler = handlerFor(keyPrefix, recorded.hooks);
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
  const recorded = recording();
  const handler = await withBrokenManifest(recorded.hooks);

  await expect(handler.refreshTags()).resolves.toBeUndefined();

  expect(opsOf(recorded.errors)).toEqual(["refreshTags"]);
});

test("with no error hook, one failure reaches console.error once", async () => {
  const handler = await withBrokenManifest({});
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  onTestFinished(() => logged.mockRestore());

  await handler.refreshTags();

  expect(logged).toHaveBeenCalledTimes(1);
  expect(logged.mock.calls[0]).toContain("refreshTags");
});

test("a tag write that fails reports the failure as updateTags, and still rejects", async () => {
  const recorded = recording();
  const handler = await withBrokenManifest(recorded.hooks);

  await expect(handler.updateTags(["posts"])).rejects.toThrow();

  expect(opsOf(recorded.errors)).toEqual(["updateTags"]);
});

test("a write that fails reports the failure as set, and set still resolves", async () => {
  const keyPrefix = freshPrefix();
  const recorded = recording();
  const handler = handlerFor(keyPrefix, recorded.hooks);
  const server = await serverClient();
  await server.set(`${keyPrefix}entry:key`, "not a hash");

  await expect(handler.set("key", Promise.resolve(entryOf()))).resolves.toBeUndefined();

  expect(opsOf(recorded.errors)).toEqual(["set"]);
  expect(recorded.events).toEqual([]);
});

test("a write fires one set event with the key and a non-negative duration", async () => {
  const recorded = recording();
  const handler = handlerFor(freshPrefix(), recorded.hooks);

  await handler.set("key", Promise.resolve(entryOf()));

  expect(recorded.events).toHaveLength(1);
  expect(recorded.events[0]).toMatchObject({ type: "set", key: "key" });
  expect(recorded.events[0]?.durationMs).toBeGreaterThanOrEqual(0);
});

test("an Entry bigger than maxEntrySize is skipped, stored nowhere, and read back absent", async () => {
  const keyPrefix = freshPrefix();
  const recorded = recording();
  const handler = handlerFor(keyPrefix, { ...recorded.hooks, maxEntrySize: 16 });
  const server = await serverClient();
  await handler.refreshTags();

  await handler.set("big", Promise.resolve(entryOf({ value: streamOf(new Uint8Array(17)) })));

  expect(recorded.events).toEqual([
    { type: "skip", reason: "too-large", size: 17, key: "big", durationMs: expect.any(Number) },
  ]);
  expect(await server.exists(`${keyPrefix}entry:big`)).toBe(0);
  expect(await handler.get("big", [])).toBeUndefined();
  expect(recorded.events.at(-1)).toMatchObject({ type: "miss", reason: "absent" });
});

test("an Entry exactly at maxEntrySize is stored", async () => {
  const keyPrefix = freshPrefix();
  const recorded = recording();
  const handler = handlerFor(keyPrefix, { ...recorded.hooks, maxEntrySize: 16 });
  const server = await serverClient();

  await handler.set("edge", Promise.resolve(entryOf({ value: streamOf(new Uint8Array(16)) })));

  expect(recorded.events).toEqual([{ type: "set", key: "edge", durationMs: expect.any(Number) }]);
  expect(await server.exists(`${keyPrefix}entry:edge`)).toBe(1);
});

test("an Entry the wrapper would read as expired is skipped and stored nowhere", async () => {
  const keyPrefix = freshPrefix();
  const recorded = recording();
  const handler = handlerFor(keyPrefix, recorded.hooks);
  const server = await serverClient();

  await handler.set("dead", Promise.resolve(entryOf({ expire: 0 })));

  expect(recorded.events).toEqual([
    {
      type: "skip",
      reason: "expire-zero",
      size: VALUE.byteLength,
      key: "dead",
      durationMs: expect.any(Number),
    },
  ]);
  expect(await server.exists(`${keyPrefix}entry:dead`)).toBe(0);
});

test("an event hook that throws leaves the write untouched", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix, {
    onEvent: () => {
      throw new Error("hook");
    },
  });
  const server = await serverClient();

  await expect(handler.set("key", Promise.resolve(entryOf()))).resolves.toBeUndefined();

  expect(await server.exists(`${keyPrefix}entry:key`)).toBe(1);
});
