import { expect, test } from "vitest";

import { optionsFromEnv } from "./env.js";

const URL_ONLY = { REDIS_URL: "redis://localhost:6379" };

test("no REDIS_URL at all means no options", () => {
  expect(optionsFromEnv({})).toBeUndefined();
});

test("an empty REDIS_URL means no options either", () => {
  expect(optionsFromEnv({ REDIS_URL: "" })).toBeUndefined();
});

test("the URL is carried over and every variable nobody set is left undefined", () => {
  const options = optionsFromEnv(URL_ONLY);

  expect(options).toEqual({
    url: "redis://localhost:6379",
    keyPrefix: undefined,
    operationTimeout: undefined,
    updateTagsTimeout: undefined,
    maxTtl: undefined,
    maxEntrySize: undefined,
    debug: undefined,
  });
});

test("every variable maps to its option, in the unit the variable documents", () => {
  const options = optionsFromEnv({
    ...URL_ONLY,
    NEXT_REDIS_CACHE_KEY_PREFIX: "app:",
    NEXT_REDIS_CACHE_MAX_TTL: "120",
    NEXT_REDIS_CACHE_MAX_ENTRY_SIZE: "2048",
    NEXT_REDIS_CACHE_OPERATION_TIMEOUT: "250",
    NEXT_REDIS_CACHE_UPDATE_TAGS_TIMEOUT: "9000",
    NEXT_REDIS_CACHE_DEBUG: "1",
  });

  expect(options).toEqual({
    url: "redis://localhost:6379",
    keyPrefix: "app:",
    maxTtl: 120,
    maxEntrySize: 2048,
    operationTimeout: 250,
    updateTagsTimeout: 9000,
    debug: true,
  });
});

test("a variable set to the empty string is not given, whatever its type", () => {
  const options = optionsFromEnv({
    ...URL_ONLY,
    NEXT_REDIS_CACHE_KEY_PREFIX: "",
    NEXT_REDIS_CACHE_MAX_TTL: "",
    NEXT_REDIS_CACHE_DEBUG: "",
  });

  expect(options?.keyPrefix).toBeUndefined();
  expect(options?.maxTtl).toBeUndefined();
  expect(options?.debug).toBeUndefined();
});

test("`1` and `true` are true, `0` and `false` are false, in any case", () => {
  const debugOf = (NEXT_REDIS_CACHE_DEBUG: string) =>
    optionsFromEnv({ ...URL_ONLY, NEXT_REDIS_CACHE_DEBUG })?.debug;

  expect([debugOf("1"), debugOf("true"), debugOf("TRUE")]).toEqual([true, true, true]);
  expect([debugOf("0"), debugOf("false"), debugOf("False")]).toEqual([false, false, false]);
});

test("a value that is no whole number at all throws, naming the variable", () => {
  const withMaxTtl = (NEXT_REDIS_CACHE_MAX_TTL: string) => () =>
    optionsFromEnv({ ...URL_ONLY, NEXT_REDIS_CACHE_MAX_TTL });

  for (const value of ["abc", "1e3", "1.5", " 5", "5 ", "-1", "+1", "0x10", "9007199254740993"]) {
    expect(withMaxTtl(value)).toThrow(/`NEXT_REDIS_CACHE_MAX_TTL`/);
  }
});

test("each numeric variable names itself when it cannot be parsed", () => {
  const names = [
    "NEXT_REDIS_CACHE_MAX_ENTRY_SIZE",
    "NEXT_REDIS_CACHE_OPERATION_TIMEOUT",
    "NEXT_REDIS_CACHE_UPDATE_TAGS_TIMEOUT",
  ];

  for (const name of names) {
    expect(() => optionsFromEnv({ ...URL_ONLY, [name]: "abc" })).toThrow(new RegExp(`\`${name}\``));
  }
});

test("a boolean outside `1`, `true`, `0` and `false` throws, naming the variable", () => {
  expect(() => optionsFromEnv({ ...URL_ONLY, NEXT_REDIS_CACHE_DEBUG: "yes" })).toThrow(
    /`NEXT_REDIS_CACHE_DEBUG`/,
  );
});

test("a value that only names a property of every object is no boolean", () => {
  expect(() => optionsFromEnv({ ...URL_ONLY, NEXT_REDIS_CACHE_DEBUG: "constructor" })).toThrow(
    /`NEXT_REDIS_CACHE_DEBUG`/,
  );
});

test("a variable is parsed even when there is no REDIS_URL to use it with", () => {
  expect(() => optionsFromEnv({ NEXT_REDIS_CACHE_MAX_TTL: "abc" })).toThrow(
    /`NEXT_REDIS_CACHE_MAX_TTL`/,
  );
});

test("a number the factory will refuse parses here and is handed over as it is", () => {
  const options = optionsFromEnv({ ...URL_ONLY, NEXT_REDIS_CACHE_MAX_TTL: "0" });

  expect(options?.maxTtl).toBe(0);
});

test("the URL is handed over verbatim, for the factory to accept or refuse", () => {
  const options = optionsFromEnv({ REDIS_URL: "http://localhost:6379" });

  expect(options?.url).toBe("http://localhost:6379");
});
