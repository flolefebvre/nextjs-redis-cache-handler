import { expect, test } from "vitest";

import {
  commandStream,
  freshPrefix,
  handlerFor,
  instancePair,
  storeBefore,
  tagCommandNames,
  wait,
} from "../tests/handler-harness.js";

const READ_COMMANDS = ["EVAL", "EVALSHA"];

const MAX_TTL_SECONDS = 1;

const PAST_MAX_TTL_MS = 1_200;

test("an event written between two refreshes is picked up without reading the manifest again", async () => {
  const { keyPrefix, instanceA, instanceB } = instancePair();
  await storeBefore(instanceA, "posts", { tags: ["posts"] });
  await instanceB.refreshTags();
  const stream = await commandStream(keyPrefix);

  await instanceA.updateTags(["posts"]);
  await instanceB.refreshTags();

  expect(await instanceB.get("posts", [])).toBeUndefined();
  const names = tagCommandNames(await stream.settled(), keyPrefix);
  expect(names).toContain("ZRANGE");
  expect(names).toContain("HMGET");
  expect(names).not.toContain("HGETALL");
});

test("the first refresh of a process reads the whole manifest", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const stream = await commandStream(keyPrefix);

  await handler.refreshTags();

  expect(tagCommandNames(await stream.settled(), keyPrefix)).toEqual(["EVALSHA", "HGETALL"]);
});

test("ten concurrent refreshes are one read round trip, and all of them resolve", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  await handler.refreshTags();
  const stream = await commandStream(keyPrefix);

  const refreshes = await Promise.all(
    Array.from({ length: 10 }, () => handler.refreshTags().then(() => "done")),
  );

  expect(refreshes).toEqual(Array.from({ length: 10 }, () => "done"));
  const reads = tagCommandNames(await stream.settled(), keyPrefix).filter((name) =>
    READ_COMMANDS.includes(name),
  );
  expect(reads).toHaveLength(1);
});

test("a tag event too old to affect any living Entry stops hiding one", async () => {
  const keyPrefix = freshPrefix();
  const writer = handlerFor(keyPrefix);
  const reader = handlerFor(keyPrefix, { maxTtl: MAX_TTL_SECONDS });
  await storeBefore(writer, "posts", { tags: ["posts"] });

  await writer.updateTags(["posts"]);
  await reader.refreshTags();

  expect(await reader.get("posts", [])).toBeUndefined();
  await wait(PAST_MAX_TTL_MS);
  await reader.refreshTags();
  expect(await reader.get("posts", [])).toBeDefined();
});

test("both reads of the Tag manifest stay within the portable command set", async () => {
  const { keyPrefix, instanceA, instanceB } = instancePair();
  const stream = await commandStream(keyPrefix);

  await instanceB.refreshTags();
  await instanceA.updateTags(["posts"]);
  await instanceB.refreshTags();

  const names = new Set(tagCommandNames(await stream.settled(), keyPrefix));
  expect(names).toEqual(new Set(["EVALSHA", "HGETALL", "ZRANGE", "HMGET", "HSET", "ZADD"]));
});
