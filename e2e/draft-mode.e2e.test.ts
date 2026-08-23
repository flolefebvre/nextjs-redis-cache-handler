import { afterAll, beforeAll, expect, test } from "vitest";

import { cookieHeader, startInstances, type Instances, type Page } from "./instances.js";
import { postMarkers } from "./pages.js";
import { outcomesOf } from "./records.js";

const BYPASS_COOKIE = "__prerender_bypass";

let instances!: Instances;
let cached!: Record<string, string>;
let draft!: Page;

beforeAll(async () => {
  instances = await startInstances("draft-mode");
});

afterAll(async () => {
  await instances?.stop();
});

test("outside Draft Mode, a second request is served from the Entries of the first", async () => {
  const from = await instances.calls.end();

  const first = await postMarkers(instances, "A");
  await instances.calls.waitFor(from, (call) => call.method === "set");
  cached = await postMarkers(instances, "A");

  expect(cached).toEqual(first);
  expect(outcomesOf(await instances.calls.since(from), "A")).toContain("get hit");
});

test("a Draft Mode request renders fresh and reads no Entry", async () => {
  draft = await instances.get("A", "/api/draft?enable=1");
  const from = await instances.calls.end();

  const drafted = await postMarkers(instances, "A", cookieHeader(draft));
  const again = await postMarkers(instances, "A", cookieHeader(draft));

  expect(draft.cookies[BYPASS_COOKIE]).toBeDefined();
  expect(drafted["post-body"]).not.toBe(cached["post-body"]);
  expect(again["post-body"]).not.toBe(drafted["post-body"]);
  expect(outcomesOf(await instances.calls.since(from), "A")).toEqual(new Set(["refreshTags ok"]));
});

test("leaving Draft Mode restores cached serving", async () => {
  const off = await instances.get("A", "/api/draft?enable=0", cookieHeader(draft));
  const from = await instances.calls.end();

  const after = await postMarkers(instances, "A", cookieHeader(off));

  expect(after).toEqual(cached);
  expect(outcomesOf(await instances.calls.since(from), "A")).toContain("get hit");
});
