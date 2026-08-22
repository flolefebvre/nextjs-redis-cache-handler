import { basename, dirname, isAbsolute } from "node:path";
import { expect, test } from "vitest";

import { createRedisCacheHandler, handlerPath } from "./index.js";

test("handlerPath is the absolute path of the Zero-config entry next to this module", () => {
  expect(isAbsolute(handlerPath)).toBe(true);
  expect(basename(handlerPath)).toBe("handler.js");
  expect(dirname(handlerPath)).toBe(import.meta.dirname);
});

test("the factory reports that it is not implemented", () => {
  expect(() => createRedisCacheHandler()).toThrow(/not implemented/);
});
