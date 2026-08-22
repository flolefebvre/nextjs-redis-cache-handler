import { expect, test } from "vitest";

import { tagKeys } from "./tag-store.js";

test("both Tag manifest keys sit under the Key prefix, in one Cluster slot", () => {
  expect(tagKeys("myapp:")).toEqual({ manifest: "myapp:{tags}", log: "myapp:{tags}:log" });
});
