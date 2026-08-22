import { expect, test, vi } from "vitest";

import { type Equals, HANDLER_METHODS as METHODS } from "../tests/unit-harness.js";
import { createRedisCacheHandler, handlerPath, optionsFromEnv } from "./index.edge.js";

const edgeMatchesNode: Equals<typeof import("./index.edge.js"), typeof import("./index.js")> = true;

test("the Edge target and the Node.js target of the entry present the same module shape", () => {
  expect(edgeMatchesNode).toBe(true);
});

test("the factory takes the options and hands back a closable disabled handler", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

  const handler = createRedisCacheHandler({ url: "redis://127.0.0.1:6379", debug: true });

  expect(
    METHODS.filter((method) => typeof handler[method as keyof typeof handler] === "function"),
  ).toEqual(METHODS);
  expect(await handler.get("key", [])).toBeUndefined();
  expect(await handler.close()).toBeUndefined();
  expect(consoleError.mock.calls[0]?.[0]).toMatch(/Edge runtime is not supported.*uncached/s);
});

test("each call is its own handler, so one Edge route reporting does not silence the next", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);

  await createRedisCacheHandler({ url: "redis://127.0.0.1:6379" }).get("key", []);
  await createRedisCacheHandler({ url: "redis://127.0.0.1:6379" }).get("key", []);

  expect(report).toHaveBeenCalledTimes(2);
});

test("handlerPath is empty: no Edge bundle can load the Zero-config entry", () => {
  expect(handlerPath).toBe("");
});

test("optionsFromEnv is the same pure reader the Node.js target exports", () => {
  expect(optionsFromEnv({})).toBeUndefined();
  expect(optionsFromEnv({ REDIS_URL: "redis://localhost:6379" })).toEqual({
    url: "redis://localhost:6379",
  });
});
