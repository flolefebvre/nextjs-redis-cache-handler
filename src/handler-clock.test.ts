import { expect, test } from "vitest";

import { parseStamp } from "./handler-clock.js";

test("a stamp is the instant the script formatted", () => {
  expect(parseStamp("1787325433671")).toBe(1787325433671);
});

test("a reply that is not a number at all is unreadable", () => {
  expect(() => parseStamp("")).toThrow();
  expect(() => parseStamp("later")).toThrow();
  expect(() => parseStamp(null)).toThrow();
  expect(() => parseStamp(undefined)).toThrow();
  expect(() => parseStamp(["1787325433671"])).toThrow();
});
