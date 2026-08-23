import { expect, test } from "vitest";

import {
  DEFAULT_TEST_IMAGE,
  meetsFloor,
  providedRedisUrl,
  REDIS_VERSION_FLOOR,
  serverVersion,
  testImage,
  VALKEY_VERSION_FLOOR,
} from "./redis-container.js";

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

test("the version of a Valkey server is read from valkey_version, never the compat redis_version", () => {
  const info = "# Server\r\nredis_version:7.2.4\r\nserver_name:valkey\r\nvalkey_version:9.1.1\r\n";

  expect(serverVersion(info)).toStrictEqual({
    family: "valkey",
    version: "9.1.1",
    floor: VALKEY_VERSION_FLOOR,
  });
});

test("the version of a Redis server is read from redis_version", () => {
  const info = "# Server\r\nredis_version:6.2.24\r\nio_threads_active:0\r\n";

  expect(serverVersion(info)).toStrictEqual({
    family: "redis",
    version: "6.2.24",
    floor: REDIS_VERSION_FLOOR,
  });
});

test("an INFO reply carrying no version at all is an error, not a passing floor", () => {
  expect(() => serverVersion("# Server\r\nio_threads_active:0\r\n")).toThrow(/version/);
});

test("a version is compared component by component, numerically", () => {
  expect(meetsFloor("6.2.24", REDIS_VERSION_FLOOR)).toBe(true);
  expect(meetsFloor("6.2", REDIS_VERSION_FLOOR)).toBe(true);
  expect(meetsFloor("6.1.9", REDIS_VERSION_FLOOR)).toBe(false);
  expect(meetsFloor("10.0.0", VALKEY_VERSION_FLOOR)).toBe(true);
  expect(meetsFloor("7.10.0", "7.2")).toBe(true);
});
