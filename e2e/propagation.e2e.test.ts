import { afterAll, beforeAll, expect, test } from "vitest";

import { startInstances, type Instances } from "./instances.js";
import { POST, postMarkers, postMarkersOnceChanged, PPR } from "./pages.js";
import { outcomesOf } from "./records.js";

let instances!: Instances;

beforeAll(async () => {
  instances = await startInstances("propagation");
});

afterAll(async () => {
  await instances?.stop();
});

test("the first request reads what `next build` prewarmed, and fills what it could not", async () => {
  const from = await instances.calls.end();

  const a = await instances.get("A", PPR);
  await instances.calls.waitFor(from, (call) => call.method === "set");
  const b = await instances.get("B", PPR);

  const calls = await instances.calls.since(from);
  expect([a.status, b.status]).toEqual([200, 200]);
  expect(outcomesOf(calls, "A")).toEqual(
    new Set(["refreshTags ok", "get hit", "getExpiration ok", "get miss:absent", "set set"]),
  );
  expect(outcomesOf(calls, "B")).toEqual(
    new Set(["refreshTags ok", "get hit", "getExpiration ok"]),
  );
});

test("an Entry one Instance wrote is served by the other", async () => {
  const from = await instances.calls.end();

  const a = await postMarkers(instances, "A");
  await instances.calls.waitFor(from, (call) => call.method === "set");
  const b = await postMarkers(instances, "B");

  expect(b).toEqual(a);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get hit");
});

test("`updateTag` on A expires the Entry B reads next", async () => {
  const before = await postMarkers(instances, "B");
  const from = await instances.calls.end();

  expect(await instances.action("A", "invalidatePosts")).toBe(200);
  const after = await postMarkersOnceChanged(instances, "B", "post-body", before["post-body"]);

  expect(after["comments"]).toBe(before["comments"]);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get miss:expired");
});

test("`revalidateTag(tag, 'max')` on A has B serve the old Entry once, then a new one", async () => {
  const before = await postMarkers(instances, "B");
  const from = await instances.calls.end();

  await instances.get("A", "/api/revalidate?tag=posts");
  const stale = await postMarkers(instances, "B");

  expect(stale["post-body"]).toBe(before["post-body"]);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get stale");

  await instances.calls.waitFor(from, (call) => call.instance === "B" && call.method === "set");
  const fresh = await postMarkersOnceChanged(instances, "B", "post-body", before["post-body"]);

  expect(fresh["post-body"]).not.toBe(before["post-body"]);
});

test("`revalidatePath` on A makes B's next render fresh", async () => {
  const before = await postMarkers(instances, "B");
  const from = await instances.calls.end();

  await instances.get("A", `/api/revalidate?path=${POST}`);
  const after = await postMarkersOnceChanged(instances, "B", "post-body", before["post-body"]);

  expect(after["comments"]).not.toBe(before["comments"]);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get miss:expired");
});

test("`revalidatePath(path, 'layout')` on A makes B's next render fresh", async () => {
  const before = await postMarkers(instances, "B");
  const from = await instances.calls.end();

  await instances.get("A", "/api/revalidate?path=/&mode=layout");
  const after = await postMarkersOnceChanged(instances, "B", "post-body", before["post-body"]);

  expect(after["remote-note"]).not.toBe(before["remote-note"]);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get miss:expired");
});

test("expiring an inner tag on A regenerates the outer scope on B, and nothing else", async () => {
  const before = await postMarkers(instances, "B");
  const from = await instances.calls.end();

  await instances.get("A", "/api/revalidate?tag=comments:1&mode=expire");
  const after = await postMarkersOnceChanged(instances, "B", "comments", before["comments"]);

  expect(after["post-body"]).toBe(before["post-body"]);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get miss:expired");
});

test("the `remote` slot shares the same store as the `default` one", async () => {
  const from = await instances.calls.end();

  await instances.get("A", "/api/revalidate?tag=remote:1&mode=expire");
  const a = await postMarkers(instances, "A");
  await instances.calls.waitFor(from, (call) => call.instance === "A" && call.method === "set");
  const b = await postMarkers(instances, "B");

  expect(b["remote-note"]).toBe(a["remote-note"]);
});

test("an Edge-bundled route renders its cached scope uncached, and records nothing", async () => {
  const from = await instances.calls.end();

  const first = await instances.get("A", "/edge");
  const second = await instances.get("A", "/edge");

  expect([first.status, second.status]).toEqual([200, 200]);
  expect(first.markers["edge"]).toBeDefined();
  expect(second.markers["edge"]).not.toBe(first.markers["edge"]);
  expect(await instances.calls.since(from)).toEqual([]);
});

test("every key this Scenario recorded belongs to this build", async () => {
  const keyed = (await instances.calls.since(0)).filter((call) => call.key !== "");

  expect(keyed.length).toBeGreaterThan(0);
  expect(keyed.every((call) => call.key.startsWith(`["${instances.buildId}"`))).toBe(true);
});
