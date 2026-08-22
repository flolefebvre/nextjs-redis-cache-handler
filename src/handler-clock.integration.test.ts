import { expect, test } from "vitest";

import {
  entryOf,
  freshPrefix,
  handlerClock,
  handlerFor,
  seedHandlerClock,
  seedTagEvents,
  serverClient,
  serverNow,
  type ServerClient,
} from "../tests/handler-harness.js";
import { WRITE_TIME_FIELD } from "./entry-hash.js";
import { entryKey } from "./entry-store.js";
import { tagKeys } from "./tag-store.js";

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

/**
 * How long the render of the Entry a held clock drops took: any length at all, as long as
 * it is shorter than the step the clock is held by, since a render of that length is what
 * puts the Write time below a tag event stamped at the same floor.
 */
const RENDER_MS = 100;

test("the first Entry of a store starts the Handler clock and is stamped from it", async () => {
  const { keyPrefix, handler, server } = await store();

  expect(await handlerClock(server, keyPrefix)).toBeUndefined();
  await handler.set("first", Promise.resolve(entryOf()));

  const clock = (await handlerClock(server, keyPrefix)) ?? 0;
  const writeTime = await writeTimeOf(server, keyPrefix, "first");
  expect(clock).toBeGreaterThan(0);
  expect(writeTime).toBeLessThanOrEqual(clock);
  expect(writeTime).toBeGreaterThan(clock - CLOCK_MARGIN_MS);
});

test("an Entry that took a while to generate is stamped that far before the clock", async () => {
  const { keyPrefix, handler, server } = await store();

  await handler.set("slow", Promise.resolve(entryOf({ timestamp: Date.now() - AGE_MS })));

  const clock = (await handlerClock(server, keyPrefix)) ?? 0;
  const writeTime = await writeTimeOf(server, keyPrefix, "slow");
  expect(writeTime).toBeLessThan(clock - AGE_MS + CLOCK_MARGIN_MS);
  expect(writeTime).toBeGreaterThan(clock - AGE_MS - CLOCK_MARGIN_MS);
});

test("no stamp the Handler clock issues is earlier than the one before it", async () => {
  const { keyPrefix, handler, server } = await store();

  await handler.set("one", Promise.resolve(entryOf()));
  const first = await handlerClock(server, keyPrefix);
  await handler.set("two", Promise.resolve(entryOf()));
  const second = await handlerClock(server, keyPrefix);
  await handler.set("three", Promise.resolve(entryOf()));
  const third = await handlerClock(server, keyPrefix);

  expect(second).toBeGreaterThanOrEqual(first ?? 0);
  expect(third).toBeGreaterThanOrEqual(second ?? 0);
});

test("a tag event issued while the wall clock sits behind the Handler clock is stamped ahead of it", async () => {
  const { keyPrefix, handler, server, stepped } = await steppedStore();

  await handler.updateTags(["posts"]);

  const [staleAt] = String(await server.hGet(tagKeys(keyPrefix).manifest, "posts")).split(":");
  expect(Number(staleAt)).toBe(stepped);
});

test("an Entry written while the wall clock sits behind the Handler clock is stamped ahead of it", async () => {
  const { keyPrefix, handler, server, stepped } = await steppedStore();

  await handler.set("posts", Promise.resolve(entryOf({ timestamp: Date.now() })));

  expect(await writeTimeOf(server, keyPrefix, "posts")).toBeGreaterThan(stepped - CLOCK_MARGIN_MS);
});

/**
 * The behaviour the decision promises, end to end. It is paired with the two cells above,
 * which pin the mechanism it rests on: this one asserts the outcome but cannot fail while
 * the stamps are read off the wall clock, since both of them then step together and the
 * arrangement collapses. Deleting either of the other two as redundant would leave the
 * mechanism untested.
 */
test("an Entry invalidated after the wall clock stepped back is dropped, not served", async () => {
  const { handler } = await steppedStore();

  await handler.set("posts", Promise.resolve(entryOf({ tags: ["posts"] })));
  await handler.updateTags(["posts"]);
  await handler.refreshTags();

  expect(await handler.get("posts", [])).toBeUndefined();
});

test("a tag event stamped after an Entry is never earlier than it, whatever the wall clock did", async () => {
  const { keyPrefix, handler, server } = await steppedStore();

  await handler.set("posts", Promise.resolve(entryOf({ tags: ["posts"], timestamp: Date.now() })));
  const written = await handlerClock(server, keyPrefix);
  await handler.updateTags(["posts"]);
  const invalidated = await handlerClock(server, keyPrefix);

  expect(invalidated).toBeGreaterThanOrEqual(written ?? 0);
});

test("an Entry whose Write time is the very instant of the tag event is dropped", async () => {
  const { keyPrefix, handler, server } = await store();
  await handler.set("posts", Promise.resolve(entryOf({ tags: ["posts"] })));
  const writeTime = await writeTimeOf(server, keyPrefix, "posts");

  await seedTagEvents(server, keyPrefix, ["posts"], writeTime, writeTime);
  await handler.refreshTags();

  expect(await handler.get("posts", [])).toBeUndefined();
});

test("an Entry whose render started after a tag event of the same hold is dropped", async () => {
  const { handler } = await steppedStore();
  await handler.updateTags(["posts"]);

  await handler.set(
    "slow",
    Promise.resolve(entryOf({ tags: ["posts"], timestamp: Date.now() - RENDER_MS })),
  );
  await handler.refreshTags();

  expect(await handler.get("slow", [])).toBeUndefined();
});

test("a refresh reads the Handler clock and issues no stamp of its own", async () => {
  const { keyPrefix, handler, server, stepped } = await steppedStore();

  await handler.refreshTags();
  await handler.refreshTags();

  expect(await handlerClock(server, keyPrefix)).toBe(stepped);
});

test("a store whose Handler clock was lost starts it again and keeps serving", async () => {
  const { keyPrefix, handler, server } = await store();
  await handler.set("before", Promise.resolve(entryOf({ tags: [] })));

  await server.del(tagKeys(keyPrefix).clock);
  await handler.set("after", Promise.resolve(entryOf({ tags: [] })));
  await handler.refreshTags();

  expect(await handlerClock(server, keyPrefix)).toBeGreaterThan(0);
  expect(await handler.get("after", [])).toBeDefined();
});

/** One Instance on a fresh store, and a plain client watching what it writes. */
async function store(): Promise<{
  keyPrefix: string;
  handler: ReturnType<typeof handlerFor>;
  server: ServerClient;
}> {
  const keyPrefix = freshPrefix();

  return { keyPrefix, handler: handlerFor(keyPrefix), server: await serverClient() };
}

/**
 * The same, on a store whose Handler clock already sits `STEP_MS` ahead of the server's
 * wall clock: what that store looks like the instant after the host stepped its clock
 * back by as much.
 */
async function steppedStore(): Promise<Awaited<ReturnType<typeof store>> & { stepped: number }> {
  const opened = await store();
  const stepped = (await serverNow(opened.server)) + STEP_MS;
  await seedHandlerClock(opened.server, opened.keyPrefix, stepped);

  return { ...opened, stepped };
}

async function writeTimeOf(
  server: ServerClient,
  keyPrefix: string,
  cacheKey: string,
): Promise<number> {
  return Number(await server.hGet(entryKey(keyPrefix, cacheKey), WRITE_TIME_FIELD));
}
