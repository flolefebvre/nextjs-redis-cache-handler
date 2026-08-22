import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  providedRedisUrl,
  startOutageRedis,
  testImage,
  type OutageRedis,
} from "./redis-container.js";

const STALL_MS = 300;

const KEY = "outage-harness:kept";

describe.skipIf(providedRedisUrl() !== undefined)("the outage server", () => {
  let redis: OutageRedis;

  beforeAll(async () => {
    redis = await startOutageRedis(testImage());
  }, 120_000);

  afterAll(async () => {
    await redis.remove();
  }, 120_000);

  test("stalls a command while paused, refuses one while stopped, and keeps its url", async () => {
    const client = createClient({ url: redis.url, disableOfflineQueue: true });
    client.on("error", () => undefined);
    await client.connect();
    await client.set(KEY, "before");

    await redis.pause();
    const stalled = client.get(KEY);
    const raced = await Promise.race([stalled, waitFor(STALL_MS).then(() => "still stalled")]);
    await redis.unpause();

    expect(raced).toBe("still stalled");
    expect(await stalled).toBe("before");

    await redis.stop();
    await expect(client.get(KEY)).rejects.toThrowError();

    await redis.start();
    const back = createClient({ url: redis.url });
    back.on("error", () => undefined);
    await back.connect();
    expect(await back.get(KEY)).toBe("before");
    await back.close();
    client.destroy();
  }, 120_000);
});

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
