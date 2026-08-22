import { afterAll, afterEach, beforeAll, describe, expect, onTestFinished, test, vi } from "vitest";

import {
  bytesOf,
  entryOf,
  freshPrefix,
  opsOf,
  recording,
  serverClient,
  tick,
  VALUE,
  wait,
} from "../tests/handler-harness.js";
import {
  providedRedisUrl,
  startOutageRedis,
  testImage,
  type OutageRedis,
} from "../tests/redis-container.js";
import { stopwatch } from "../tests/unit-harness.js";
import type { CacheErrorOp, CacheEvent } from "./events.js";
import type { RedisCacheHandlerOptions } from "./options.js";
import { createRedisCacheHandler } from "./redis-cache-handler.js";
import { tagKeys } from "./tag-store.js";
import type { CacheHandler } from "./types.js";

const TIMEOUT = 200;

const MARGIN = 800;

const PATIENT_TIMEOUT = 10_000;

const RETRY_BUDGET = 1_000;

const PROMPT_MS = 500;

const LATE_MS = 500;

const SETTLE_MS = 50;

const STALL_MS = 250;

const RECOVERY_MS = 30_000;

const CONTAINER_TIMEOUT = 120_000;

describe.skipIf(providedRedisUrl() !== undefined)("under an outage", () => {
  let redis: OutageRedis;
  const unhandled: unknown[] = [];
  const collect = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeAll(async () => {
    process.on("unhandledRejection", collect);
    process.on("uncaughtException", collect);
    redis = await startOutageRedis(testImage());
  }, CONTAINER_TIMEOUT);

  afterAll(async () => {
    process.off("unhandledRejection", collect);
    process.off("uncaughtException", collect);
    await redis.remove();
  }, CONTAINER_TIMEOUT);

  afterEach(async () => {
    await wait(SETTLE_MS);

    expect(unhandled).toEqual([]);
  });

  function handler(keyPrefix: string, overrides: Partial<RedisCacheHandlerOptions> = {}) {
    const built = createRedisCacheHandler({ url: redis.url, keyPrefix, ...overrides });
    onTestFinished(() => built.close());

    return built;
  }

  /** One Instance that has read the Tag manifest once, and everything it reports. */
  async function ready(keyPrefix: string, overrides: Partial<RedisCacheHandlerOptions> = {}) {
    const recorded = recording();
    const instance = handler(keyPrefix, {
      operationTimeout: TIMEOUT,
      ...recorded.hooks,
      ...overrides,
    });
    await instance.refreshTags();

    return { instance, recorded };
  }

  /** What one operation came to against a stalled server, and how long the caller waited. */
  async function whileStalled<T>(run: () => Promise<T>): Promise<{ outcome: T; waitedMs: number }> {
    await redis.pause();
    onTestFinished(() => redis.unpause());
    const elapsed = stopwatch();
    const outcome = await run();
    const waitedMs = elapsed();
    await redis.unpause();

    return { outcome, waitedMs };
  }

  /**
   * How an invalidation issued against a stalled server settled, the server answering
   * again after longer than one attempt is given and well inside the retry budget.
   */
  async function invalidatedWhileStalled(other: CacheHandler): Promise<"resolved" | "rejected"> {
    const { outcome } = await whileStalled(async () => {
      const invalidating = other.updateTags(["posts"]);
      await wait(STALL_MS);
      await redis.unpause();

      return settling(invalidating);
    });

    return outcome;
  }

  async function whileDown(): Promise<void> {
    await redis.stop();
    onTestFinished(() => redis.start());
  }

  test(
    "a read of a stalled server is a miss `timeout` within the deadline, and is reported",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const { instance, recorded } = await ready(freshPrefix());
      await instance.set("stalled-read", Promise.resolve(entryOf()));
      expect(await instance.get("stalled-read", [])).toBeDefined();

      const { outcome, waitedMs } = await whileStalled(() => instance.get("stalled-read", []));

      expect(outcome).toBeUndefined();
      expect(waitedMs).toBeLessThan(TIMEOUT + MARGIN);
      expect(lastMiss(recorded.events)).toBe("timeout");
      expect(opsOf(recorded.errors)).toContain("get");
    },
  );

  test(
    "a write to a stalled server is dropped within the deadline, and is reported",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const { instance, recorded } = await ready(freshPrefix());

      const { outcome, waitedMs } = await whileStalled(() =>
        instance.set("stalled-write", Promise.resolve(entryOf())),
      );

      expect(outcome).toBeUndefined();
      expect(waitedMs).toBeLessThan(TIMEOUT + MARGIN);
      expect(opsOf(recorded.errors)).toContain("set");
      expect(recorded.events.map((event) => event.type)).not.toContain("set");
    },
  );

  test(
    "an invalidation of a stalled server retries for its whole budget, then throws once",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const { instance, recorded } = await ready(freshPrefix(), {
        updateTagsTimeout: RETRY_BUDGET,
      });

      const { outcome, waitedMs } = await whileStalled(() => settling(instance.updateTags(["a"])));

      expectGaveUp(outcome, waitedMs, recorded.errors);
      expect(String(reportedFor(recorded.errors, "updateTags").at(0))).toContain("updateTags");
    },
  );

  test(
    "an invalidation of a server that is down retries for its budget rather than at once",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const { instance, recorded } = await ready(freshPrefix(), {
        updateTagsTimeout: RETRY_BUDGET,
      });

      await whileDown();
      const elapsed = stopwatch();
      const outcome = await settling(instance.updateTags(["a"]));
      const waitedMs = elapsed();

      expectGaveUp(outcome, waitedMs, recorded.errors);
    },
  );

  test(
    "an invalidation of a stalled server that answers within the budget lands once",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const keyPrefix = freshPrefix();
      const { instance } = await ready(keyPrefix);
      const other = handler(keyPrefix, {
        operationTimeout: TIMEOUT,
        updateTagsTimeout: RETRY_BUDGET,
      });
      await instance.set(
        "invalidated-within-budget",
        Promise.resolve(entryOf({ tags: ["posts"] })),
      );
      await tick();
      expect(await instance.get("invalidated-within-budget", [])).toBeDefined();

      const outcome = await invalidatedWhileStalled(other);
      await instance.refreshTags();

      expect(outcome).toBe("resolved");
      expect(await instance.get("invalidated-within-budget", [])).toBeUndefined();
      const observer = await serverClient(redis.url);
      expect(await observer.zCard(tagKeys(keyPrefix).log)).toBe(1);
    },
  );

  test(
    "an invalidation with no tag is not a round trip, whatever the server is doing",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const { instance, recorded } = await ready(freshPrefix(), {
        updateTagsTimeout: RETRY_BUDGET,
      });

      const { waitedMs } = await whileStalled(() => settling(instance.updateTags([])));

      expect(waitedMs).toBeLessThan(PROMPT_MS);
      expect(opsOf(recorded.errors)).not.toContain("updateTags");
    },
  );

  test(
    "an Entry read before the server stalled is served again once it answers",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const { instance } = await ready(freshPrefix());
      await instance.set("recovered", Promise.resolve(entryOf()));

      const { outcome } = await whileStalled(() => instance.get("recovered", []));

      expect(outcome).toBeUndefined();
      const served = await instance.get("recovered", []);
      expect(await bytesOf((served ?? entryOf()).value)).toEqual(VALUE);
    },
  );

  test(
    "a refresh of a stalled server keeps the manifest read before it stalled",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const keyPrefix = freshPrefix();
      const { instance, recorded } = await ready(keyPrefix);
      const other = handler(keyPrefix);
      await instance.set("kept-manifest", Promise.resolve(entryOf({ tags: ["posts"] })));
      await tick();
      await other.updateTags(["posts"]);
      await instance.refreshTags();

      const { waitedMs } = await whileStalled(() => instance.refreshTags());

      expect(waitedMs).toBeLessThan(TIMEOUT + MARGIN);
      expect(opsOf(recorded.errors)).toContain("refreshTags");
      expect(await instance.get("kept-manifest", [])).toBeUndefined();
      expect(lastMiss(recorded.events)).toBe("expired");
    },
  );

  test(
    "an invalidation issued while the server was stalled is applied after one refresh",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const keyPrefix = freshPrefix();
      const { instance } = await ready(keyPrefix);
      const other = handler(keyPrefix, { operationTimeout: PATIENT_TIMEOUT });
      await instance.set("invalidated-late", Promise.resolve(entryOf({ tags: ["posts"] })));
      await tick();
      expect(await instance.get("invalidated-late", [])).toBeDefined();

      const outcome = await invalidatedWhileStalled(other);
      await instance.refreshTags();

      expect(outcome).toBe("resolved");
      expect(await instance.get("invalidated-late", [])).toBeUndefined();
    },
  );

  test(
    "a refresh that ran out of time never lands, however late its read answers",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const keyPrefix = freshPrefix();
      const recorded = recording();
      const other = handler(keyPrefix);
      await other.set("late-refresh", Promise.resolve(entryOf()));
      const instance = handler(keyPrefix, { operationTimeout: TIMEOUT, ...recorded.hooks });

      await whileStalled(() => instance.refreshTags());
      await wait(LATE_MS);

      expect(await instance.get("late-refresh", [])).toBeUndefined();
      expect(lastMiss(recorded.events)).toBe("unavailable");
      await instance.refreshTags();
      expect(await instance.get("late-refresh", [])).toBeDefined();
    },
  );

  test(
    "a read and a write against a server that is down give up at once, and are reported",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const { instance, recorded } = await ready(freshPrefix(), {
        operationTimeout: PATIENT_TIMEOUT,
      });
      await instance.set("server-down", Promise.resolve(entryOf()));

      await whileDown();
      const elapsed = stopwatch();
      const read = await instance.get("server-down", []);
      const written = await settling(instance.set("server-down", Promise.resolve(entryOf())));
      const waitedMs = elapsed();

      expect(read).toBeUndefined();
      expect(written).toBe("resolved");
      expect(lastMiss(recorded.events)).toBe("unavailable");
      expect(waitedMs).toBeLessThan(PROMPT_MS);
      expect(opsOf(recorded.errors)).toContain("get");
      expect(opsOf(recorded.errors)).toContain("set");
      expect(opsOf(recorded.errors)).toContain("connect");
    },
  );

  test(
    "a handler that never read the manifest misses until the server is up, then recovers",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const recorded = recording();
      await whileDown();
      const instance = handler(freshPrefix(), { operationTimeout: TIMEOUT, ...recorded.hooks });

      await expect(instance.refreshTags()).resolves.toBeUndefined();
      expect(await instance.get("never-read", [])).toBeUndefined();
      const elapsed = stopwatch();
      await expect(instance.refreshTags()).resolves.toBeUndefined();

      expect(lastMiss(recorded.events)).toBe("unavailable");
      expect(elapsed()).toBeLessThan(PROMPT_MS);
      expect(opsOf(recorded.errors)).toContain("refreshTags");
      expect(opsOf(recorded.errors)).toContain("connect");

      await redis.start();

      await vi.waitUntil(
        async () => {
          await instance.refreshTags();
          await instance.set("never-read", Promise.resolve(entryOf()));

          return (await instance.get("never-read", [])) !== undefined;
        },
        { timeout: RECOVERY_MS, interval: SETTLE_MS },
      );
    },
  );

  test(
    "an invalidation written while a handler was down is seen on its first refresh after",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const keyPrefix = freshPrefix();
      const { instance, recorded } = await ready(keyPrefix);

      await whileDown();
      expect(await instance.get("re-synced", [])).toBeUndefined();
      await redis.start();
      const other = handler(keyPrefix, { operationTimeout: PATIENT_TIMEOUT });
      await other.set("re-synced", Promise.resolve(entryOf({ tags: ["posts"] })));
      await tick();
      await other.updateTags(["posts"]);

      await vi.waitUntil(
        async () => {
          await instance.get("re-synced-probe", []);

          return lastMiss(recorded.events) === "absent";
        },
        { timeout: RECOVERY_MS, interval: SETTLE_MS },
      );
      await instance.refreshTags();

      expect(await instance.get("re-synced", [])).toBeUndefined();
      expect(lastMiss(recorded.events)).toBe("expired");
    },
  );
});

/** How one operation settled, for a test that asserts that and not what it gave back. */
function settling(operation: Promise<unknown>): Promise<"resolved" | "rejected"> {
  return operation.then(
    () => "resolved" as const,
    () => "rejected" as const,
  );
}

/**
 * What an invalidation that never reached the server comes to: one rejection, at the end
 * of the budget rather than at the end of one attempt, reported exactly once.
 */
function expectGaveUp(
  outcome: "resolved" | "rejected",
  waitedMs: number,
  errors: [unknown, CacheErrorOp][],
): void {
  expect(outcome).toBe("rejected");
  expect(waitedMs).toBeGreaterThanOrEqual(RETRY_BUDGET - TIMEOUT);
  expect(waitedMs).toBeLessThan(RETRY_BUDGET + TIMEOUT + MARGIN);
  expect(reportedFor(errors, "updateTags")).toHaveLength(1);
}

/** What was reported for one operation, in order: how a test counts the calls of `onError`. */
function reportedFor(errors: [unknown, CacheErrorOp][], op: CacheErrorOp): unknown[] {
  return errors.filter(([, reported]) => reported === op).map(([error]) => error);
}

function lastMiss(events: CacheEvent[]): string | undefined {
  const misses = events.filter((event) => event.type === "miss");

  return misses.at(-1)?.reason;
}
