import type {} from "vitest";
import type { TestProject } from "vitest/node";

import { providedRedisUrl, startRedisContainer, testImage } from "../tests/redis-container.js";
import { buildFixtures, type FixtureBuilds } from "./fixture-build.js";

declare module "vitest" {
  interface ProvidedContext {
    /** The builds of the run, and their store, read by `startInstances`. */
    e2eBuilds: FixtureBuilds;
  }
}

/**
 * Give the e2e project its store and its builds: one server for the run — the one
 * `CACHE_TEST_REDIS_URL` names, or a throwaway container — one `next build` of the Fixture
 * app against it, so every Scenario on that build starts from the same prewarmed Entries,
 * and one against the Zero-config entry with no store at all.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const provided = providedRedisUrl();
  const redis =
    provided === undefined
      ? await startRedisContainer(testImage())
      : { url: provided, stop: () => Promise.resolve() };

  try {
    project.provide("e2eBuilds", await buildFixtures(redis.url));
  } catch (error) {
    await redis.stop();
    throw error;
  }

  return async () => {
    await redis.stop();
  };
}
