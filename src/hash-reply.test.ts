import { expect, test } from "vitest";

import { hashFieldsOf } from "./hash-reply.js";

test("a flat field/value array reads as the fields of the hash", () => {
  expect(hashFieldsOf(["tags", '["posts"]', "stale", "300"])).toEqual({
    tags: '["posts"]',
    stale: "300",
  });
});

test("a value is handed on exactly as it came, bytes no UTF-8 decoder would give back too", () => {
  const value = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0xc3, 0x28]);

  expect(hashFieldsOf([Buffer.from("value"), value])).toEqual({ value });
});

test("a hash the store holds nothing for reads as no fields at all", () => {
  expect(hashFieldsOf([])).toEqual({});
});

test("a reply that is not a flat field/value array is a failure, not an empty hash", () => {
  expect(() => hashFieldsOf(undefined)).toThrow();
  expect(() => hashFieldsOf("value")).toThrow();
  expect(() => hashFieldsOf({ value: "1" })).toThrow();
  expect(() => hashFieldsOf(["value"])).toThrow();
});

test("a field named __proto__ is a field like any other, not the prototype", () => {
  const fields = hashFieldsOf(["__proto__", "1:2", "tags", "[]"]);

  expect(Object.entries(fields)).toEqual([
    ["__proto__", "1:2"],
    ["tags", "[]"],
  ]);
});
