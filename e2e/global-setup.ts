import type {} from "vitest";
import type { TestProject } from "vitest/node";

import { providedRedisUrl, startRedisContainer, testImage } from "../tests/redis-container.js";
import { buildFixture, type FixtureBuild } from "./fixture-build.js";

declare module "vitest" {
  interface ProvidedContext {
    /** The one build of the run, read by `startFixture`. */
    e2eBuild: FixtureBuild;
  }
}

/**
 * Give the e2e project its store and its build: one server for the run — the one
 * `CACHE_TEST_REDIS_URL` names, or a throwaway container — and one `next build` of the
 * Fixture app against it, so every Scenario starts from the same prewarmed Entries.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const provided = providedRedisUrl();
  const redis =
    provided === undefined
      ? await startRedisContainer(testImage())
      : { url: provided, stop: () => Promise.resolve() };

  try {
    project.provide("e2eBuild", await buildFixture(redis.url));
  } catch (error) {
    await redis.stop();
    throw error;
  }

  return async () => {
    await redis.stop();
  };
}
