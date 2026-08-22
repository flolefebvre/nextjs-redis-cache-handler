import { expect, test } from "vitest";

import {
  bytesOf,
  entryOf,
  freshPrefix,
  handlerFor,
  serverClient,
  VALUE,
} from "../tests/handler-harness.js";

test("the scripts are sent again after the server's script cache was flushed", async () => {
  const handler = handlerFor(freshPrefix());
  const server = await serverClient();
  await handler.set("flushed", Promise.resolve(entryOf()));
  await handler.updateTags(["posts"]);

  await server.sendCommand(["SCRIPT", "FLUSH"]);

  await handler.set("flushed", Promise.resolve(entryOf({ tags: [] })));
  await expect(handler.updateTags(["posts"])).resolves.toBeUndefined();
  await handler.refreshTags();
  const entry = await handler.get("flushed", []);
  expect(entry).toBeDefined();
  expect(await bytesOf(entry?.value ?? new ReadableStream())).toEqual(VALUE);
});
