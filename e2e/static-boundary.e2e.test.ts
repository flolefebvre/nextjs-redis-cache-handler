import { afterAll, beforeAll, expect, test } from "vitest";

import { startInstances, type Instances } from "./instances.js";
import { LIST, postMarkers, postMarkersOnceChanged, PPR } from "./pages.js";
import { outcomesOf } from "./records.js";

let instances!: Instances;
let listPage!: string | undefined;
let shell!: string | undefined;
let hole!: string | undefined;
let post!: Record<string, string>;

beforeAll(async () => {
  instances = await startInstances("static-boundary");
});

afterAll(async () => {
  await instances?.stop();
});

test("both Instances serve a Prerendered route from their own copy, consulting no Handler", async () => {
  const from = await instances.calls.end();

  const a = await instances.get("A", LIST);
  const b = await instances.get("B", LIST);

  expect(a.markers["list-page"]).toBeDefined();
  expect(b.markers["list-page"]).toBe(a.markers["list-page"]);
  expect(await instances.calls.since(from)).toEqual([]);
  listPage = a.markers["list-page"];
});

test("the shell of a PPR route is prerendered too, while its hole reads an Entry per request", async () => {
  const from = await instances.calls.end();

  const a = await instances.get("A", PPR);
  const b = await instances.get("B", PPR);

  expect(a.markers["ppr-shell"]).toBeDefined();
  expect(b.markers["ppr-shell"]).toBe(a.markers["ppr-shell"]);
  expect(b.markers["ppr-request"]).not.toBe(a.markers["ppr-request"]);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get hit");
  shell = a.markers["ppr-shell"];
  hole = b.markers["ppr-hole"];
  post = await postMarkers(instances, "B");
});

test("`updateTag` on A leaves B's PPR shell on its own copy and expires the Entry of its hole", async () => {
  const from = await instances.calls.end();

  expect(await instances.action("A", "invalidatePosts")).toBe(200);
  const b = await instances.get("B", PPR);

  expect(b.markers["ppr-shell"]).toBe(shell);
  expect(b.markers["ppr-hole"]).not.toBe(hole);
  expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get miss:expired");
});

test("a dynamic route on B is fresh right after that same `updateTag`", async () => {
  const fresh = await postMarkersOnceChanged(instances, "B", "post-body", post["post-body"]);

  expect(fresh["post-body"]).not.toBe(post["post-body"]);
});

test("B keeps serving its own Prerendered copy of the route A has already regenerated", async () => {
  const from = await instances.calls.end();

  const b = await instances.get("B", LIST);
  const a = await instances.markersOnceChanged("A", LIST, "list-page", listPage);

  expect(b.markers["list-page"]).toBe(listPage);
  expect(a["list-page"]).not.toBe(listPage);
  expect(outcomesOf(await instances.calls.since(from), "B")).toEqual(new Set());
});

test("a revalidation on B brings B's own copy to a new marker", async () => {
  await instances.get("B", "/api/revalidate?tag=posts");
  const b = await instances.markersOnceChanged("B", LIST, "list-page", listPage);

  expect(b["list-page"]).not.toBe(listPage);
});
