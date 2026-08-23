import { expect } from "vitest";

import type { Instances } from "./instances.js";
import { postMarkers, postMarkersOnceChanged } from "./pages.js";
import { outcomesOf } from "./records.js";

/**
 * The steps two Scenarios take identically. A Scenario whose narrative reaches a point
 * another one already asserts takes the step from here rather than restating it: what a
 * Scenario needs twice lives in the harness, and one step then has one set of assertions
 * wherever it is taken.
 */

/**
 * One Entry, written by whichever Instance rendered it and served by the other: A renders
 * the post page, and B answers the same instants from that Entry rather than from a render
 * of its own.
 */
export async function expectOneEntryServedByBoth(instances: Instances): Promise<void> {
  const from = await instances.calls.end();

  const a = await postMarkers(instances, "A");
  await instances.calls.waitFor(from, (call) => call.method === "set");
  const b = await postMarkers(instances, "B");

  expect(b).toEqual(a);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get hit");
}

/**
 * `updateTag` on A expiring the Entry B reads next: B's post body is regenerated, and the
 * scope that does not carry the tag is left alone.
 */
export async function expectUpdateTagReachesB(instances: Instances): Promise<void> {
  const before = await postMarkers(instances, "B");
  const from = await instances.calls.end();

  expect(await instances.action("A", "invalidatePosts")).toBe(200);
  const after = await postMarkersOnceChanged(instances, "B", "post-body", before["post-body"]);

  expect(after["comments"]).toBe(before["comments"]);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get miss:expired");
}
