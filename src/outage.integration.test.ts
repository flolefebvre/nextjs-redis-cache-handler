import { afterAll, afterEach, beforeAll, describe, expect, onTestFinished, test, vi } from "vitest";

import {
  bytesOf,
  entryOf,
  freshPrefix,
  opsOf,
  recording,
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
import type { CacheEvent } from "./events.js";
import { createRedisCacheHandler } from "./redis-cache-handler.js";
import type { RedisCacheHandlerOptions } from "./options.js";

const TIMEOUT = 200;

const MARGIN = 800;

const CONTAINER_TIMEOUT = 120_000;

const SETTLE_MS = 50;

const LATE_MS = 500;

const PATIENT_TIMEOUT = 10_000;

const PROMPT_MS = 500;

const RECOVERY_MS = 30_000;

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

  async function paused(): Promise<void> {
    await redis.pause();
    onTestFinished(() => redis.unpause());
  }

  async function stopped(): Promise<void> {
    await redis.stop();
    onTestFinished(() => redis.start());
  }

  function handler(keyPrefix: string, overrides: Partial<RedisCacheHandlerOptions> = {}) {
    const built = createRedisCacheHandler({ url: redis.url, keyPrefix, ...overrides });
    onTestFinished(() => built.close());

    return built;
  }

  test(
    "a read of a stalled server is a miss `timeout` within the deadline, and is reported",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const recorded = recording();
      const instance = handler(freshPrefix(), { operationTimeout: TIMEOUT, ...recorded.hooks });
      await instance.set("stalled-read", Promise.resolve(entryOf()));
      await instance.refreshTags();
      expect(await instance.get("stalled-read", [])).toBeDefined();

      await paused();
      const startedAt = Date.now();
      const read = await instance.get("stalled-read", []);
      const elapsed = Date.now() - startedAt;
      await redis.unpause();

      expect(read).toBeUndefined();
      expect(elapsed).toBeLessThan(TIMEOUT + MARGIN);
      expect(lastMiss(recorded.events)).toBe("timeout");
      expect(opsOf(recorded.errors)).toContain("get");
    },
  );

  test(
    "a write to a stalled server is dropped within the deadline, and is reported",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const recorded = recording();
      const instance = handler(freshPrefix(), { operationTimeout: TIMEOUT, ...recorded.hooks });
      await instance.refreshTags();

      await paused();
      const startedAt = Date.now();
      await expect(
        instance.set("stalled-write", Promise.resolve(entryOf())),
      ).resolves.toBeUndefined();
      const elapsed = Date.now() - startedAt;
      await redis.unpause();

      expect(elapsed).toBeLessThan(TIMEOUT + MARGIN);
      expect(opsOf(recorded.errors)).toContain("set");
      expect(recorded.events.map((event) => event.type)).not.toContain("set");
    },
  );

  test(
    "an invalidation of a stalled server gives up within the deadline, and throws",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const recorded = recording();
      const instance = handler(freshPrefix(), { operationTimeout: TIMEOUT, ...recorded.hooks });
      await instance.refreshTags();

      await paused();
      const startedAt = Date.now();
      await expect(instance.updateTags(["posts"])).rejects.toThrowError();
      const elapsed = Date.now() - startedAt;
      await redis.unpause();

      expect(elapsed).toBeLessThan(TIMEOUT + MARGIN);
      expect(opsOf(recorded.errors)).toContain("updateTags");
    },
  );

  test(
    "an Entry read before the server stalled is served again once it answers",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const instance = handler(freshPrefix(), { operationTimeout: TIMEOUT });
      await instance.set("recovered", Promise.resolve(entryOf()));
      await instance.refreshTags();

      await paused();
      expect(await instance.get("recovered", [])).toBeUndefined();
      await redis.unpause();

      const served = await instance.get("recovered", []);
      expect(served).toBeDefined();
      expect(await bytesOf((served ?? entryOf()).value)).toEqual(VALUE);
    },
  );

  test(
    "a refresh of a stalled server keeps the manifest read before it stalled",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const keyPrefix = freshPrefix();
      const recorded = recording();
      const instance = handler(keyPrefix, { operationTimeout: TIMEOUT, ...recorded.hooks });
      const other = handler(keyPrefix);
      await instance.set("kept-manifest", Promise.resolve(entryOf({ tags: ["posts"] })));
      await other.updateTags(["posts"]);
      await instance.refreshTags();

      await paused();
      const startedAt = Date.now();
      await expect(instance.refreshTags()).resolves.toBeUndefined();
      const elapsed = Date.now() - startedAt;
      await redis.unpause();

      expect(elapsed).toBeLessThan(TIMEOUT + MARGIN);
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
      const instance = handler(keyPrefix, { operationTimeout: TIMEOUT });
      const other = handler(keyPrefix, { operationTimeout: PATIENT_TIMEOUT });
      await instance.set("invalidated-late", Promise.resolve(entryOf({ tags: ["posts"] })));
      await instance.refreshTags();
      expect(await instance.get("invalidated-late", [])).toBeDefined();

      await paused();
      const invalidating = other.updateTags(["posts"]);
      await wait(SETTLE_MS);
      await redis.unpause();
      await invalidating;

      await instance.refreshTags();
      expect(await instance.get("invalidated-late", [])).toBeUndefined();
    },
  );

  test(
    "a refresh that ran out of time never lands, however late its read answers",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const keyPrefix = freshPrefix();
      const recorded = recording();
      const instance = handler(keyPrefix, { operationTimeout: TIMEOUT, ...recorded.hooks });
      const other = handler(keyPrefix);
      await other.set("late-refresh", Promise.resolve(entryOf()));

      await paused();
      await expect(instance.refreshTags()).resolves.toBeUndefined();
      await redis.unpause();
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
      const recorded = recording();
      const instance = handler(freshPrefix(), {
        operationTimeout: PATIENT_TIMEOUT,
        ...recorded.hooks,
      });
      await instance.set("server-down", Promise.resolve(entryOf()));
      await instance.refreshTags();

      await stopped();
      const startedAt = Date.now();
      const read = await instance.get("server-down", []);
      await expect(
        instance.set("server-down", Promise.resolve(entryOf())),
      ).resolves.toBeUndefined();
      const elapsed = Date.now() - startedAt;
      await redis.start();

      expect(read).toBeUndefined();
      expect(lastMiss(recorded.events)).toBe("unavailable");
      expect(elapsed).toBeLessThan(PROMPT_MS);
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
      await stopped();
      const instance = handler(freshPrefix(), { operationTimeout: TIMEOUT, ...recorded.hooks });

      await expect(instance.refreshTags()).resolves.toBeUndefined();
      expect(await instance.get("never-read", [])).toBeUndefined();
      expect(lastMiss(recorded.events)).toBe("unavailable");
      const startedAt = Date.now();
      await expect(instance.refreshTags()).resolves.toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(PROMPT_MS);
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
      const recorded = recording();
      const instance = handler(keyPrefix, { operationTimeout: TIMEOUT, ...recorded.hooks });
      await instance.refreshTags();

      await stopped();
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

function lastMiss(events: CacheEvent[]): string | undefined {
  const misses = events.filter((event) => event.type === "miss");

  return misses.at(-1)?.reason;
}
