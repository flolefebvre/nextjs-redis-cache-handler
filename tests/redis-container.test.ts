import { expect, test } from "vitest";

import { DEFAULT_TEST_IMAGE, providedRedisUrl, testImage } from "./redis-container.js";

test("the image defaults to the pinned one and CACHE_TEST_IMAGE overrides it", () => {
  expect(testImage({})).toBe(DEFAULT_TEST_IMAGE);
  expect(testImage({ CACHE_TEST_IMAGE: "  " })).toBe(DEFAULT_TEST_IMAGE);
  expect(testImage({ CACHE_TEST_IMAGE: "redis:8" })).toBe("redis:8");
});

test("CACHE_TEST_REDIS_URL, when set, replaces the container", () => {
  expect(providedRedisUrl({})).toBeUndefined();
  expect(providedRedisUrl({ CACHE_TEST_REDIS_URL: "  " })).toBeUndefined();
  expect(providedRedisUrl({ CACHE_TEST_REDIS_URL: "redis://localhost:6379" })).toBe(
    "redis://localhost:6379",
  );
});
