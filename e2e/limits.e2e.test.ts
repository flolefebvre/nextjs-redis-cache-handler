import { afterAll, beforeAll, expect, test } from "vitest";

import { startInstances, type Instances } from "./instances.js";
import { bigMarker, postMarkers } from "./pages.js";
import { outcomesOf, type RecordedCall } from "./records.js";

/**
 * The Entry size cap both Instances of this Scenario run under: above every scope of the
 * post page (4–6 KB each) and far below the 500-row table (≈500 KB), so that one page of
 * the Fixture is dropped and the other one keeps caching.
 */
const MAX_ENTRY_SIZE = 65_536;

let instances!: Instances;
let bigOnA!: string;

beforeAll(async () => {
  instances = await startInstances("limits", {
    env: { NEXT_REDIS_CACHE_MAX_ENTRY_SIZE: String(MAX_ENTRY_SIZE) },
  });
});

afterAll(async () => {
  await instances?.stop();
});

test("an Entry over the cap is dropped, and the page it belongs to still serves", async () => {
  const from = await instances.calls.end();

  bigOnA = await bigMarker(instances, "A");
  const calls = await instances.calls.waitFor(from, isSkip("A"));

  const skipped = calls.find(isSkip("A"));
  expect(skipped?.size).toBeGreaterThan(MAX_ENTRY_SIZE);
  expect(outcomesOf(calls, "A")).toContain("get miss:absent");
});

test("the other Instance finds nothing to serve, renders its own, and drops it too", async () => {
  const from = await instances.calls.end();

  const bigOnB = await bigMarker(instances, "B");
  const calls = await instances.calls.waitFor(from, isSkip("B"));

  expect(bigOnB).not.toBe(bigOnA);
  expect(outcomesOf(calls, "B")).toContain("get miss:absent");
  expect(outcomesOf(calls, "B")).not.toContain("get hit");
});

test("a page under the cap is still served from its Entry on the next request", async () => {
  const from = await instances.calls.end();

  const first = await postMarkers(instances, "A");
  await instances.calls.waitFor(from, (call) => call.instance === "A" && call.method === "set");
  const second = await postMarkers(instances, "A");

  expect(second).toEqual(first);
  expect(outcomesOf(await instances.calls.since(from), "A")).toContain("get hit");
});

function isSkip(instance: string): (call: RecordedCall) => boolean {
  return (call) =>
    call.instance === instance && call.method === "set" && call.outcome === "skip:too-large";
}
