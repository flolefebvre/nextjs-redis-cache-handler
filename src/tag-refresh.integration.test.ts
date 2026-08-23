import { expect, onTestFinished, test } from "vitest";

import {
  commandStream,
  entryOf,
  freshPrefix,
  handlerFor,
  instancePair,
  opsOf,
  recording,
  seedHandlerClock,
  seedTagEvents,
  serverClient,
  type ServerClient,
  serverNow,
  storeBefore,
  tagCommandNames,
  tick,
} from "../tests/handler-harness.js";
import { stopwatch } from "../tests/unit-harness.js";
import { DEFAULT_OPERATION_TIMEOUT } from "./options.js";
import { createRedisCacheHandler } from "./redis-cache-handler.js";

const MAX_TTL_SECONDS = 1;

const ENTRY_AGE_MS = 120_000;

const EVENT_AGE_MS = 60_000;

const RACES = 50;

const SEEDED_TAGS = 100_000;

const SEED_BATCH = 20_000;

const SEEDED_AGE_MS = 60_000;

const SLOW_TIMEOUT_MS = 60_000;

/**
 * How many fields of the Tag manifest a watermark refresh may name, out of the
 * SEEDED_TAGS the manifest holds: only the warm-up tag was written inside the margin the
 * read reaches back over, and a read that fell back to the whole log would name every
 * seeded tag instead.
 */
const WATERMARK_FIELDS = 10;

/**
 * How far ahead of the server's wall clock a cell holds the Handler clock: more than any
 * backward step the host is known to take, the ten seconds `STEP_MS` stands for in
 * `handler-clock.integration.test.ts`.
 */
const HOLD_MS = 10_000;

const SEED = `
local clock = redis.call('TIME')
local score = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000) - ${SEEDED_AGE_MS}
local value = string.format('%d', score) .. ':' .. string.format('%d', score)
for index = 1, #ARGV do
  redis.call('HSET', KEYS[1], ARGV[index], value)
  redis.call('ZADD', KEYS[2], score, ARGV[index])
end
return 1
`;

test("an event written between two refreshes is picked up without reading the manifest again", async () => {
  const { keyPrefix, instanceA, instanceB } = instancePair();
  await storeBefore(instanceA, "posts", { tags: ["posts"] });
  await holdHandlerClockAhead(keyPrefix);
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

  expect(tagCommandNames(await stream.settled(), keyPrefix)).toEqual(["EVALSHA", "GET", "HGETALL"]);
});

test("ten concurrent refreshes are one read round trip, and all of them resolve", async () => {
  const keyPrefix = freshPrefix();
  await holdHandlerClockAhead(keyPrefix);
  const handler = handlerFor(keyPrefix);
  await handler.refreshTags();
  await handler.refreshTags();
  const stream = await commandStream(keyPrefix);

  const refreshes = await Promise.all(
    Array.from({ length: 10 }, () => handler.refreshTags().then(() => "done")),
  );

  expect(refreshes).toEqual(Array.from({ length: 10 }, () => "done"));
  expect(tagCommandNames(await stream.settled(), keyPrefix)).toEqual([
    "EVALSHA",
    "GET",
    "ZCARD",
    "HLEN",
    "ZRANGE",
  ]);
});

test("a tag event too old to affect any living Entry stops hiding one", async () => {
  const keyPrefix = freshPrefix();
  const writer = handlerFor(keyPrefix);
  const reader = handlerFor(keyPrefix, { maxTtl: MAX_TTL_SECONDS });
  const server = await serverClient();
  const entry = entryOf({ tags: ["posts"], timestamp: Date.now() - ENTRY_AGE_MS });
  await writer.set("posts", Promise.resolve(entry));
  const past = (await serverNow(server)) - EVENT_AGE_MS;

  await seedTagEvents(server, keyPrefix, ["posts"], past, past);
  await holdHandlerClockAhead(keyPrefix);
  await reader.refreshTags();

  expect(await reader.get("posts", [])).toBeUndefined();
  await reader.refreshTags();
  expect(await reader.get("posts", [])).toBeDefined();
});

test("both reads of the Tag manifest stay within the portable command set", async () => {
  const { keyPrefix, instanceA, instanceB } = instancePair();
  await holdHandlerClockAhead(keyPrefix);
  const stream = await commandStream(keyPrefix);

  await instanceB.refreshTags();
  await instanceA.updateTags(["posts"]);
  await instanceB.refreshTags();

  const names = new Set(tagCommandNames(await stream.settled(), keyPrefix));
  expect(names).toEqual(
    new Set(["EVALSHA", "GET", "HGETALL", "ZCARD", "HLEN", "ZRANGE", "HMGET", "HSET", "ZADD"]),
  );
});

test("a Tag manifest whose log was lost is read whole again", async () => {
  const { keyPrefix, instanceA, instanceB } = instancePair();
  const server = await serverClient();
  await storeBefore(instanceA, "posts", { tags: ["posts"] });
  await instanceB.refreshTags();
  await instanceA.updateTags(["posts"]);
  await server.del(`${keyPrefix}{tags}:log`);
  const stream = await commandStream(keyPrefix);

  await instanceB.refreshTags();

  expect(await instanceB.get("posts", [])).toBeUndefined();
  expect(tagCommandNames(await stream.settled(), keyPrefix)).toContain("HGETALL");
});

test("a handler whose client reconnected reads the whole manifest and sees what it missed", async () => {
  const keyPrefix = freshPrefix();
  const injected = await serverClient();
  const handler = createRedisCacheHandler({ client: injected, keyPrefix });
  onTestFinished(() => handler.close());
  const writer = handlerFor(keyPrefix);
  await storeBefore(writer, "posts", { tags: ["posts"] });
  await handler.refreshTags();
  const killer = await serverClient();
  const stream = await commandStream(keyPrefix);
  const reconnected = new Promise((resolve) => injected.once("ready", resolve));

  await killer.sendCommand(["CLIENT", "KILL", "ID", String(await injected.clientId())]);
  await writer.updateTags(["posts"]);
  await reconnected;
  await handler.refreshTags();

  expect(await handler.get("posts", [])).toBeUndefined();
  expect(tagCommandNames(await stream.settled(), keyPrefix)).toContain("HGETALL");
});

test("two Instances writing on the same millisecond are both seen by a third", async () => {
  const keyPrefix = freshPrefix();
  const [writerA, writerB, reader] = [
    handlerFor(keyPrefix),
    handlerFor(keyPrefix),
    handlerFor(keyPrefix),
  ];
  const rounds = Array.from({ length: RACES }, (_, round) => [`a:${round}`, `b:${round}`] as const);
  await Promise.all(
    rounds.flat().map((tag) => reader.set(tag, Promise.resolve(entryOf({ tags: [tag] })))),
  );
  await tick();
  await reader.refreshTags();

  const served: string[] = [];
  for (const [tagA, tagB] of rounds) {
    await Promise.all([writerA.updateTags([tagA]), writerB.updateTags([tagB])]);
    await reader.refreshTags();
    for (const tag of [tagA, tagB]) {
      if ((await reader.get(tag, [])) !== undefined) served.push(tag);
    }
  }

  expect(served).toEqual([]);
});

test(
  "with a manifest of a hundred thousand tags, a watermark refresh reads a handful of them",
  { timeout: SLOW_TIMEOUT_MS },
  async () => {
    const keyPrefix = freshPrefix();
    const server = await serverClient();
    await seedManifest(server, keyPrefix, SEEDED_TAGS);
    await holdHandlerClockAhead(keyPrefix);
    const { errors, hooks } = recording();
    const handler = handlerFor(keyPrefix, hooks);
    await handler.updateTags(["warm-up"]);
    await handler.refreshTags();
    const stream = await commandStream(keyPrefix);

    const elapsed = stopwatch();
    await handler.refreshTags();
    const watermarkMs = elapsed();

    const commands = await stream.settled();
    expect(opsOf(errors)).toEqual([]);
    expect(tagCommandNames(commands, keyPrefix)).not.toContain("HGETALL");
    expect(manifestFieldsRead(commands, keyPrefix)).toBeLessThanOrEqual(WATERMARK_FIELDS);
    expect(watermarkMs).toBeLessThan(DEFAULT_OPERATION_TIMEOUT);
  },
);

/**
 * Persist a Handler clock floor above the server's wall clock, so that every read of this
 * Key prefix comes back at that floor: a value no backward step of the host's wall clock
 * can bring a later read below, which keeps the watermark comparison of two reads with no
 * stamp between them monotone for the whole cell (ADR 0003).
 *
 * It goes before the tag events the cell stamps, never after them: a stamp issued under
 * the floor lands on it, so those events stay inside the margin the next read reaches back
 * over, while a floor raised after them would leave them a hold below it, outside the
 * range that read asks for. An event a cell seeds at a score of its own is not a stamp and
 * is unaffected either way — but the floor still goes after the Entries the cell writes,
 * whose Write time it would otherwise raise above such an event.
 *
 * A stamp issued under the held clock persists nothing — the floor is already there — so
 * no `SET` of the clock key appears in a stream recorded under it.
 */
async function holdHandlerClockAhead(keyPrefix: string): Promise<void> {
  const server = await serverClient();

  await seedHandlerClock(server, keyPrefix, (await serverNow(server)) + HOLD_MS);
}

async function seedManifest(server: ServerClient, keyPrefix: string, tags: number): Promise<void> {
  for (let first = 0; first < tags; first += SEED_BATCH) {
    const batch = Array.from({ length: SEED_BATCH }, (_, index) => `seeded:${first + index}`);
    await server.eval(SEED, {
      keys: [`${keyPrefix}{tags}`, `${keyPrefix}{tags}:log`],
      arguments: batch,
    });
  }
}

function manifestFieldsRead(commands: string[][], keyPrefix: string): number {
  return commands
    .filter(
      (command) =>
        (command[0] ?? "").toUpperCase() === "HMGET" && command[1] === `${keyPrefix}{tags}`,
    )
    .reduce((fields, command) => fields + command.length - 2, 0);
}
