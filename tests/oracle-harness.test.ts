import { expect, test } from "vitest";

import type { CacheEntry, CacheHandler } from "../src/types.js";
import { entryOf, streamOf, tick, VALUE } from "./handler-harness.js";
import {
  expectDivergence,
  expectProjection,
  oracleHandler,
  projectRead,
  PROJECTED_VALUE,
  type ProjectedRead,
} from "./oracle-harness.js";

const AGE_MS = 2_000;

const HIT: ProjectedRead = {
  outcome: "hit",
  tags: ["harness:post"],
  stale: 300,
  ageMs: AGE_MS,
  expire: 900,
  revalidate: 60,
  value: PROJECTED_VALUE,
};

/** A handler that serves one Entry and leaves the Soft-tag check to its `get`, as ours does. */
function servingHandler(entry: CacheEntry): CacheHandler {
  return {
    get: () => Promise.resolve(entry),
    set: () => Promise.resolve(),
    refreshTags: () => Promise.resolve(),
    getExpiration: () => Promise.resolve(Infinity),
    updateTags: () => Promise.resolve(),
  };
}

test("a key nothing was stored under projects as a miss", async () => {
  const handler = oracleHandler();

  expect(await projectRead(handler, "absent", [], Date.now())).toEqual({ outcome: "miss" });
});

test("a stored Entry projects with its tags, its timings and its value", async () => {
  const handler = oracleHandler();
  const anchor = Date.now();

  await handler.set(
    "stored",
    Promise.resolve(entryOf({ tags: ["harness:post"], timestamp: anchor - AGE_MS })),
  );

  expect(await projectRead(handler, "stored", [], anchor)).toEqual(HIT);
});

test("an Entry a Soft tag expired projects as a miss, though the Oracle's get served it", async () => {
  const handler = oracleHandler();
  const anchor = Date.now();

  await handler.set(
    "soft",
    Promise.resolve(entryOf({ tags: ["harness:soft:post"], timestamp: anchor })),
  );
  await tick();
  await handler.updateTags(["harness:soft:path"]);

  expect(await handler.get("soft", ["harness:soft:path"])).toBeDefined();
  expect(await projectRead(handler, "soft", ["harness:soft:path"], anchor)).toEqual({
    outcome: "miss",
  });
});

test("a handler answering Infinity has its own get decide, and its Entry is served", async () => {
  const anchor = Date.now();
  const handler = servingHandler(
    entryOf({ tags: ["harness:post"], timestamp: anchor - AGE_MS, value: streamOf(VALUE) }),
  );

  expect(await projectRead(handler, "served", ["harness:path"], anchor)).toEqual(HIT);
});

test("an Entry served once more projects as stale", async () => {
  const handler = servingHandler(
    entryOf({ tags: ["harness:post"], timestamp: Date.now() - AGE_MS, revalidate: -1 }),
  );

  expect(await projectRead(handler, "served", [], Date.now())).toMatchObject({
    outcome: "stale",
    revalidate: -1,
  });
});

test("timings within a second of the expected ones are the expected ones", () => {
  expectProjection({ ...HIT, ageMs: AGE_MS + 999 }, HIT);

  expect(() => expectProjection({ ...HIT, ageMs: AGE_MS + 1_001 }, HIT)).toThrow();
});

test("a divergence that stopped being one fails", () => {
  expectDivergence({ outcome: "miss" }, HIT);

  expect(() => expectDivergence({ ...HIT, ageMs: AGE_MS + 999 }, HIT)).toThrow();
});
