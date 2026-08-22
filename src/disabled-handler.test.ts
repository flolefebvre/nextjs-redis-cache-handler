import { expect, test, vi } from "vitest";

import { createDisabledHandler, EDGE_UNSUPPORTED, NO_REDIS_URL } from "./disabled-handler.js";
import type { CacheEntry } from "./types.js";

function entry(): CacheEntry {
  return {
    value: new ReadableStream<Uint8Array>(),
    tags: [],
    stale: 0,
    timestamp: 0,
    expire: 900,
    revalidate: 60,
  };
}

test("every read is a miss and every write resolves", async () => {
  const handler = createDisabledHandler(NO_REDIS_URL, () => undefined);

  expect(await handler.get("key", [])).toBeUndefined();
  expect(await handler.set("key", Promise.resolve(entry()))).toBeUndefined();
  expect(await handler.refreshTags()).toBeUndefined();
  expect(await handler.updateTags(["posts"])).toBeUndefined();
});

test("getExpiration hands the Soft tags back to get, as the Redis-backed handler does", async () => {
  const handler = createDisabledHandler(NO_REDIS_URL, () => undefined);

  expect(await handler.getExpiration(["posts"])).toBe(Infinity);
});

test("the report says that REDIS_URL is not set and that the cache is disabled", async () => {
  const report = vi.fn();
  const handler = createDisabledHandler(NO_REDIS_URL, report);

  await handler.get("key", []);

  expect(report).toHaveBeenCalledOnce();
  expect(report.mock.calls[0]?.[0]).toMatch(/REDIS_URL.*disabled/s);
});

test("the report is the message the caller handed over, whichever it is", async () => {
  const report = vi.fn();
  const handler = createDisabledHandler(EDGE_UNSUPPORTED, report);

  await handler.get("key", []);

  expect(report).toHaveBeenCalledExactlyOnceWith(EDGE_UNSUPPORTED);
});

test("the Edge message says the Edge runtime is unsupported and the scope renders uncached", () => {
  expect(EDGE_UNSUPPORTED).toMatch(/Edge runtime is not supported/);
  expect(EDGE_UNSUPPORTED).toMatch(/uncached/);
});

test("many operations report once, whichever one came first", async () => {
  const report = vi.fn();
  const handler = createDisabledHandler(NO_REDIS_URL, report);

  await handler.updateTags(["posts"]);
  await handler.refreshTags();
  await Promise.all([handler.get("a", []), handler.get("b", []), handler.getExpiration([])]);
  await handler.set("a", Promise.resolve(entry()));

  expect(report).toHaveBeenCalledOnce();
});

test("nothing is reported before the handler is used", () => {
  const report = vi.fn();

  createDisabledHandler(NO_REDIS_URL, report);

  expect(report).not.toHaveBeenCalled();
});

test("a pending Entry that rejects is drained, so no rejection is left unhandled", async () => {
  const handler = createDisabledHandler(NO_REDIS_URL, () => undefined);
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);

  await handler.set("key", Promise.reject(new Error("the render failed")));
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", unhandled);

  expect(unhandled).not.toHaveBeenCalled();
});

test("the console is where the report goes when the caller names no reporter", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const handler = createDisabledHandler(NO_REDIS_URL);

  await handler.get("key", []);

  expect(consoleError).toHaveBeenCalledOnce();
});
