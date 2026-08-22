import { expect, test } from "vitest";

import handler from "./handler.js";

test("the Zero-config entry default-exports a plain object without a default property", () => {
  expect(typeof handler).toBe("object");
  expect(handler).not.toHaveProperty("default");
});

test("every method reports that it is not implemented", () => {
  const pendingEntry = Promise.resolve({
    value: new ReadableStream<Uint8Array>(),
    tags: [],
    stale: 0,
    timestamp: 0,
    expire: 0,
    revalidate: 0,
  });

  expect(() => handler.get("key", [])).toThrow(/not implemented/);
  expect(() => handler.set("key", pendingEntry)).toThrow(/not implemented/);
  expect(() => handler.refreshTags()).toThrow(/not implemented/);
  expect(() => handler.getExpiration([])).toThrow(/not implemented/);
  expect(() => handler.updateTags([])).toThrow(/not implemented/);
});
