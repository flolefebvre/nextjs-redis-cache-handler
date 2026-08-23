import { afterAll, beforeAll, expect, test } from "vitest";

import { startInstances, type Instances, type InstanceName } from "./instances.js";
import { outcomesOf } from "./records.js";

const POST = "/posts/1";
const POST_MARKERS = ["comments", "post-body", "remote-note"];

let instances!: Instances;

beforeAll(async () => {
  instances = await startInstances("propagation");
});

afterAll(async () => {
  await instances?.stop();
});

test("the first request on each Instance reads what `next build` prewarmed", async () => {
  const from = await instances.calls.end();

  const a = await instances.get("A", "/ppr");
  const b = await instances.get("B", "/ppr");

  const calls = await instances.calls.since(from);
  expect([a.status, b.status]).toEqual([200, 200]);
  expect(outcomesOf(calls, "A")).toEqual(
    new Set(["refreshTags ok", "get hit", "getExpiration ok"]),
  );
  expect(outcomesOf(calls, "B")).toEqual(outcomesOf(calls, "A"));
});

test("an Entry one Instance wrote is served by the other", async () => {
  const from = await instances.calls.end();

  const a = await postMarkers("A");
  await instances.calls.waitFor(from, (call) => call.method === "set");
  const b = await postMarkers("B");

  expect(b).toEqual(a);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get hit");
});

test("`updateTag` on A expires the Entry B reads next", async () => {
  const before = await postMarkers("B");
  const from = await instances.calls.end();

  expect(await instances.action("A", "invalidatePosts")).toBe(200);
  const after = await markersOnceChanged("B", "post-body", before["post-body"]);

  expect(after["comments"]).toBe(before["comments"]);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get miss:expired");
});

test("`revalidateTag(tag, 'max')` on A has B serve the old Entry once, then a new one", async () => {
  const before = await postMarkers("B");
  const from = await instances.calls.end();

  await instances.get("A", "/api/revalidate?tag=posts");
  const stale = await postMarkers("B");

  expect(stale["post-body"]).toBe(before["post-body"]);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get stale");

  await instances.calls.waitFor(from, (call) => call.instance === "B" && call.method === "set");
  const fresh = await markersOnceChanged("B", "post-body", before["post-body"]);

  expect(fresh["post-body"]).not.toBe(before["post-body"]);
});

test("`revalidatePath` on A makes B's next render fresh", async () => {
  const before = await postMarkers("B");
  const from = await instances.calls.end();

  await instances.get("A", `/api/revalidate?path=${POST}`);
  const after = await markersOnceChanged("B", "post-body", before["post-body"]);

  expect(after["comments"]).not.toBe(before["comments"]);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get miss:expired");
});

test("`revalidatePath(path, 'layout')` on A makes B's next render fresh", async () => {
  const before = await postMarkers("B");
  const from = await instances.calls.end();

  await instances.get("A", "/api/revalidate?path=/&mode=layout");
  const after = await markersOnceChanged("B", "post-body", before["post-body"]);

  expect(after["remote-note"]).not.toBe(before["remote-note"]);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get miss:expired");
});

test("expiring an inner tag on A regenerates the outer scope on B, and nothing else", async () => {
  const before = await postMarkers("B");
  const from = await instances.calls.end();

  await instances.get("A", "/api/revalidate?tag=comments:1&mode=expire");
  const after = await markersOnceChanged("B", "comments", before["comments"]);

  expect(after["post-body"]).toBe(before["post-body"]);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get miss:expired");
});

test("the `remote` slot shares the same store as the `default` one", async () => {
  const from = await instances.calls.end();

  await instances.get("A", "/api/revalidate?tag=remote:1&mode=expire");
  const a = await postMarkers("A");
  await instances.calls.waitFor(from, (call) => call.instance === "A" && call.method === "set");
  const b = await postMarkers("B");

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

/** The post page's markers on one Instance, once the named scope has re-rendered. */
async function markersOnceChanged(
  instance: InstanceName,
  marker: string,
  before: string | undefined,
): Promise<Record<string, string>> {
  const markers = await instances.markersOnceChanged(instance, POST, marker, before);
  expect(Object.keys(markers).sort()).toEqual(POST_MARKERS);

  return markers;
}

/**
 * What every cached scope of the post page rendered at, on one Instance. Every marker has
 * to be there: a page that rendered none would make every comparison below a comparison of
 * two absent values, which passes without observing anything.
 */
async function postMarkers(instance: InstanceName): Promise<Record<string, string>> {
  const { markers } = await instances.get(instance, POST);
  expect(Object.keys(markers).sort()).toEqual(POST_MARKERS);

  return markers;
}
