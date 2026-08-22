import { afterAll, afterEach, beforeAll, describe, expect, onTestFinished, test } from "vitest";

import {
  bytesOf,
  entryOf,
  freshPrefix,
  opsOf,
  recording,
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

  test(
    "a read of a stalled server is a miss `timeout` within the deadline, and is reported",
    { timeout: CONTAINER_TIMEOUT },
    async () => {
      const recorded = recording();
      const instance = handler(freshPrefix(), { operationTimeout: TIMEOUT, ...recorded.hooks });
      await instance.set("stalled-read", Promise.resolve(entryOf()));
      await instance.refreshTags();
      expect(await instance.get("stalled-read", [])).toBeDefined();

      await redis.pause();
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

      await redis.pause();
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

      await redis.pause();
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

      await redis.pause();
      expect(await instance.get("recovered", [])).toBeUndefined();
      await redis.unpause();

      const served = await instance.get("recovered", []);
      expect(served).toBeDefined();
      expect(await bytesOf((served ?? entryOf()).value)).toEqual(VALUE);
    },
  );
});

function lastMiss(events: CacheEvent[]): string | undefined {
  const misses = events.filter((event) => event.type === "miss");

  return misses.at(-1)?.reason;
}
