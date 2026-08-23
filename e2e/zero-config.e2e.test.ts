import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { NO_REDIS_URL } from "../src/disabled-handler.js";
import { startInstances, type Instances } from "./instances.js";
import { BIG, LIST, POST, postMarkers, postMarkersOnceChanged, PPR } from "./pages.js";

const PAGES = [LIST, POST, PPR, BIG];

/**
 * The Fixture on the build that registers the library's Zero-config entry: no recording
 * wrapper is in the path, so this Scenario asserts on what a caller sees — HTTP output —
 * and on what each Instance logged, and on nothing else.
 */
describe("configured by environment variables alone", () => {
  let instances!: Instances;
  let cached!: Record<string, string>;

  beforeAll(async () => {
    instances = await startInstances("zero-config", { build: "zero-config" });
  });

  afterAll(async () => {
    await instances?.stop();
  });

  test("both Instances serve one Entry, written by whichever of them rendered it", async () => {
    cached = await instances.markersOnceStable("B", POST, "post-body");

    expect(await postMarkers(instances, "A")).toEqual(cached);
  });

  test("`updateTag` on A makes B fresh on its next request", async () => {
    expect(await instances.action("A", "invalidatePosts")).toBe(200);
    const after = await postMarkersOnceChanged(instances, "B", "post-body", cached["post-body"]);

    expect(after["post-body"]).not.toBe(cached["post-body"]);
    expect(after["comments"]).toBe(cached["comments"]);
  });
});

/**
 * The same build, on Instances that were given no store at all: the case a deployment
 * whose `REDIS_URL` never made it into the environment is in. The app owes its pages
 * anyway, uncached, and owes one line saying why.
 */
describe("with no store configured", () => {
  let instances!: Instances;

  beforeAll(async () => {
    instances = await startInstances("zero-config-no-store", {
      build: "zero-config",
      store: "none",
    });
  });

  afterAll(async () => {
    await instances?.stop();
  });

  test("every page still serves, on both Instances", async () => {
    const pages = await Promise.all(
      PAGES.flatMap((path) => [instances.get("A", path), instances.get("B", path)]),
    );

    expect(pages.map((page) => page.status)).toEqual(PAGES.flatMap(() => [200, 200]));
    expect(pages.every((page) => Object.keys(page.markers).length > 0)).toBe(true);
  });

  test("each Instance says once that it has no store, however much it then serves", async () => {
    expect(await instances.logged("A", NO_REDIS_URL)).toHaveLength(1);
    expect(await instances.logged("B", NO_REDIS_URL)).toHaveLength(1);

    await Promise.all(
      PAGES.flatMap((path) => [instances.get("A", path), instances.get("B", path)]),
    );

    expect(await instances.logged("A", NO_REDIS_URL)).toHaveLength(1);
    expect(await instances.logged("B", NO_REDIS_URL)).toHaveLength(1);
  });
});
