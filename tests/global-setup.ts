import type {} from "vitest";
import type { TestProject } from "vitest/node";

import { providedRedisUrl, startRedisContainer, testImage } from "./redis-container.js";

declare module "vitest" {
  interface ProvidedContext {
    /** Connection URL every integration worker talks to, via `inject("redisUrl")`. */
    redisUrl: string;
  }
}

/**
 * Provide the integration project with a server: the one `CACHE_TEST_REDIS_URL` names,
 * or a throwaway container started once per run, before any worker is forked.
 */
export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  const url = providedRedisUrl();
  if (url) {
    project.provide("redisUrl", url);
    return;
  }

  const redis = await startRedisContainer(testImage());
  project.provide("redisUrl", redis.url);

  return async () => {
    await redis.stop();
  };
}
