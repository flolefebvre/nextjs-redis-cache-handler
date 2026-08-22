import { expect, test } from "vitest";

import { tagKeys } from "./tag-store.js";

test("every key of the tag slot sits under the Key prefix, in one Cluster slot", () => {
  expect(tagKeys("myapp:")).toEqual({
    manifest: "myapp:{tags}",
    log: "myapp:{tags}:log",
    clock: "myapp:{tags}:clock",
  });
});
