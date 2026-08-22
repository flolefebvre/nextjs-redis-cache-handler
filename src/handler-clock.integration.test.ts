import { expect, test } from "vitest";

import {
  entryOf,
  freshPrefix,
  handlerClock,
  handlerFor,
  serverClient,
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
