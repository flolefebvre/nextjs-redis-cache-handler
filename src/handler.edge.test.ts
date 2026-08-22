import { expect, test, vi } from "vitest";

import { entryOf, type Equals, HANDLER_METHODS as METHODS } from "../tests/unit-harness.js";
import handler from "./handler.edge.js";

const edgeMatchesNode: Equals<
  typeof import("./handler.edge.js"),
  typeof import("./handler.node.js")
> = true;

test("the Edge target is one plain object with the five methods and no default property", () => {
  expect(typeof handler).toBe("object");
  expect(
    METHODS.filter((method) => typeof handler[method as keyof typeof handler] === "function"),
  ).toEqual(METHODS);
  expect(handler).not.toHaveProperty("default");
});

test("the Edge target and the Node.js target present the same module shape", () => {
  expect(edgeMatchesNode).toBe(true);
});

test("every read is a miss, every write is dropped, and the Edge runtime is named once", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

  expect(await handler.get("key", [])).toBeUndefined();
  await handler.set("key", entryOf());
  await handler.refreshTags();
  expect(await handler.getExpiration(["posts"])).toBe(Infinity);
  await handler.updateTags(["posts"]);

  expect(consoleError).toHaveBeenCalledOnce();
  expect(consoleError.mock.calls[0]?.[0]).toMatch(/Edge runtime is not supported.*uncached/s);
});
