import { expect, test } from "vitest";

import { entryAge, entryKey, entryTtlSeconds } from "./entry-store.js";

test("an Entry key is the Key prefix, verbatim, then Next.js's cache key raw", () => {
  expect(entryKey("myapp:", "build-id:fn:args")).toBe("myapp:entry:build-id:fn:args");
});

test("an Entry lives for its expire, capped by the TTL cap", () => {
  expect(entryTtlSeconds(900, 2_592_000)).toBe(900);
  expect(entryTtlSeconds(3600, 60)).toBe(60);
  expect(entryTtlSeconds(1.9, 60)).toBe(1);
});

test("never means the TTL cap, whatever the cap is", () => {
  expect(entryTtlSeconds(4294967294, 2_592_000)).toBe(2_592_000);
  expect(entryTtlSeconds(4294967294, 10_000_000_000)).toBe(10_000_000_000);
  expect(entryTtlSeconds(Infinity, 10_000_000_000)).toBe(10_000_000_000);
});

test("an Entry's age is how long its generation has been running", () => {
  expect(entryAge(1787325433671, 1787325433771)).toBe(100);
  expect(entryAge(1787325433671, 1787325433671)).toBe(0);
});

test("an Entry generated in the future is as old as one generated now", () => {
  expect(entryAge(1787325438671, 1787325433671)).toBe(0);
});
