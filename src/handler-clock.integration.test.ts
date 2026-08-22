import { expect, test } from "vitest";

import {
  entryOf,
  freshPrefix,
  handlerClock,
  handlerFor,
  seedHandlerClock,
  serverClient,
  serverNow,
} from "../tests/handler-harness.js";
import { WRITE_TIME_FIELD } from "./entry-hash.js";
import { entryKey } from "./entry-store.js";

const AGE_MS = 60_000;

/**
 * How far the Write time may sit from where the age says it should, so that neither the
 * round trip between the tick and the Entry write nor a step of the app clock while the
 * age was being measured can fail an assertion the handler never broke.
 */
const CLOCK_MARGIN_MS = 5_000;

/**
 * How far ahead of the server's wall clock the Handler clock is seeded: what the store
 * looks like right after that wall clock stepped ten seconds backwards, without a test
 * ever moving a clock of its own.
 */
const STEP_MS = 10_000;

test("the first Entry of a store starts the Handler clock and is stamped from it", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();

  expect(await handlerClock(server, keyPrefix)).toBeUndefined();
  await handler.set("first", Promise.resolve(entryOf()));

  const clock = await handlerClock(server, keyPrefix);
  const writeTime = await writeTimeOf(server, keyPrefix, "first");
  expect(clock).toBeGreaterThan(0);
  expect(writeTime).toBeLessThanOrEqual(clock ?? 0);
  expect(writeTime).toBeGreaterThan((clock ?? 0) - CLOCK_MARGIN_MS);
});

test("an Entry that took a while to generate is stamped that far before the clock", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();

  await handler.set("slow", Promise.resolve(entryOf({ timestamp: Date.now() - AGE_MS })));

  const clock = (await handlerClock(server, keyPrefix)) ?? 0;
  const writeTime = await writeTimeOf(server, keyPrefix, "slow");
  expect(writeTime).toBeLessThan(clock - AGE_MS + CLOCK_MARGIN_MS);
  expect(writeTime).toBeGreaterThan(clock - AGE_MS - CLOCK_MARGIN_MS);
});

test("every stamp the Handler clock issues is later than the one before it", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();

  await handler.set("one", Promise.resolve(entryOf()));
  const first = await handlerClock(server, keyPrefix);
  await handler.set("two", Promise.resolve(entryOf()));
  const second = await handlerClock(server, keyPrefix);
  await handler.set("three", Promise.resolve(entryOf()));
  const third = await handlerClock(server, keyPrefix);

  expect(second).toBeGreaterThan(first ?? 0);
  expect(third).toBeGreaterThan(second ?? 0);
});

async function writeTimeOf(
  server: Awaited<ReturnType<typeof serverClient>>,
  keyPrefix: string,
  cacheKey: string,
): Promise<number> {
  return Number(await server.hGet(entryKey(keyPrefix, cacheKey), WRITE_TIME_FIELD));
}

test("a tag event issued while the wall clock sits behind the Handler clock is stamped ahead of it", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();
  const stepped = (await serverNow(server)) + STEP_MS;
  await seedHandlerClock(server, keyPrefix, stepped);

  await handler.updateTags(["posts"]);

  const [staleAt] = String(await server.hGet(`${keyPrefix}{tags}`, "posts")).split(":");
  expect(Number(staleAt)).toBeGreaterThan(stepped);
});

test("an Entry written while the wall clock sits behind the Handler clock is stamped ahead of it", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();
  const stepped = (await serverNow(server)) + STEP_MS;
  await seedHandlerClock(server, keyPrefix, stepped);

  await handler.set("posts", Promise.resolve(entryOf({ timestamp: Date.now() })));

  expect(await writeTimeOf(server, keyPrefix, "posts")).toBeGreaterThan(stepped - CLOCK_MARGIN_MS);
});

test("an Entry invalidated after the wall clock stepped back is dropped, not served", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();
  await seedHandlerClock(server, keyPrefix, (await serverNow(server)) + STEP_MS);

  await handler.set("posts", Promise.resolve(entryOf({ tags: ["posts"] })));
  await handler.updateTags(["posts"]);
  await handler.refreshTags();

  expect(await handler.get("posts", [])).toBeUndefined();
});

test("a tag event stamped after an Entry is later than it, whatever the wall clock did", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();
  await seedHandlerClock(server, keyPrefix, (await serverNow(server)) + STEP_MS);

  await handler.set("posts", Promise.resolve(entryOf({ tags: ["posts"], timestamp: Date.now() })));
  const written = await handlerClock(server, keyPrefix);
  await handler.updateTags(["posts"]);
  const invalidated = await handlerClock(server, keyPrefix);

  expect(invalidated).toBeGreaterThan(written ?? 0);
});

test("a refresh reads the Handler clock and issues no stamp of its own", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();
  const stepped = (await serverNow(server)) + STEP_MS;
  await seedHandlerClock(server, keyPrefix, stepped);

  await handler.refreshTags();
  await handler.refreshTags();

  expect(await handlerClock(server, keyPrefix)).toBe(stepped);
});

test("a store whose Handler clock was lost starts it again and keeps serving", async () => {
  const keyPrefix = freshPrefix();
  const handler = handlerFor(keyPrefix);
  const server = await serverClient();
  await handler.set("before", Promise.resolve(entryOf({ tags: [] })));

  await server.del(`${keyPrefix}{tags}:clock`);
  await handler.set("after", Promise.resolve(entryOf({ tags: [] })));
  await handler.refreshTags();

  expect(await handlerClock(server, keyPrefix)).toBeGreaterThan(0);
  expect(await handler.get("after", [])).toBeDefined();
});
