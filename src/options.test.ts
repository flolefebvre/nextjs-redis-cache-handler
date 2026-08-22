import { createClient } from "redis";
import { expect, test } from "vitest";

import { createRedisCacheHandler } from "./redis-cache-handler.js";
import {
  DEFAULT_KEY_PREFIX,
  DEFAULT_MAX_ENTRY_SIZE,
  DEFAULT_MAX_TTL,
  DEFAULT_OPERATION_TIMEOUT,
  DEFAULT_UPDATE_TAGS_TIMEOUT,
  resolveOptions,
  type RedisCacheHandlerOptions,
} from "./options.js";

const URL = "redis://localhost:6379";

function resolving(options: unknown): () => unknown {
  return () => resolveOptions(options as RedisCacheHandlerOptions);
}

test("a URL alone resolves to every default", () => {
  const resolved = resolveOptions({ url: URL });

  expect(resolved).toEqual({
    connection: { url: URL },
    keyPrefix: DEFAULT_KEY_PREFIX,
    operationTimeout: DEFAULT_OPERATION_TIMEOUT,
    updateTagsTimeout: DEFAULT_UPDATE_TAGS_TIMEOUT,
    maxTtl: DEFAULT_MAX_TTL,
    maxEntrySize: DEFAULT_MAX_ENTRY_SIZE,
    onEvent: undefined,
    onError: undefined,
    debug: false,
  });
});

test("every given value is kept as it was given", () => {
  const onEvent = (): void => undefined;
  const onError = (): void => undefined;

  const resolved = resolveOptions({
    url: "rediss://user:pass@example.com:6380",
    keyPrefix: "app:",
    operationTimeout: 250,
    updateTagsTimeout: 10_000,
    maxTtl: 60,
    maxEntrySize: 2048,
    onEvent,
    onError,
    debug: true,
  });

  expect(resolved).toEqual({
    connection: { url: "rediss://user:pass@example.com:6380" },
    keyPrefix: "app:",
    operationTimeout: 250,
    updateTagsTimeout: 10_000,
    maxTtl: 60,
    maxEntrySize: 2048,
    onEvent,
    onError,
    debug: true,
  });
});

test("an injected client resolves to a client connection", () => {
  const client = injectableClient();

  expect(resolveOptions({ client }).connection).toEqual({ client });
});

test("the options object is not written to", () => {
  const options: RedisCacheHandlerOptions = { url: URL };

  resolveOptions(options);

  expect(options).toEqual({ url: URL });
});

test("neither a URL nor a client is an error", () => {
  expect(resolving({})).toThrowError("exactly one of `url` and `client`");
  expect(resolving({})).toThrowError("neither was given");
});

test("both a URL and a client is an error", () => {
  expect(resolving({ url: URL, client: injectableClient() })).toThrowError("both were given");
});

test("an options argument that is not an object is an error", () => {
  expect(resolving(undefined)).toThrowError("options must be an object");
  expect(resolving(null)).toThrowError("options must be an object");
});

test("an unknown key is an error naming that key", () => {
  expect(resolving({ url: URL, maxTTL: 60 })).toThrowError("unknown option `maxTTL`");
  expect(resolving({ url: URL, password: "secret" })).toThrowError("unknown option `password`");
});

test.for([
  ["a URL with another protocol", { url: "http://localhost:6379" }],
  ["a URL that does not parse", { url: "localhost:6379" }],
  ["an empty URL", { url: "" }],
  ["a URL that is not a string", { url: 6379 }],
])("%s is an error naming `url`", ([, options]) => {
  expect(resolving(options)).toThrowError("`url` must be a `redis://` or `rediss://`");
});

test.for([
  ["a client that is not an object", { client: "my-client" }],
  ["a client without the commands the handler needs", { client: {} }],
])("%s is an error naming `client`", ([, options]) => {
  expect(resolving(options)).toThrowError("`client` must be a node-redis client");
});

test.for([
  ["an empty string", ""],
  ["a number", 12],
  ["null", null],
])("a `keyPrefix` that is %s is an error naming it", ([, keyPrefix]) => {
  expect(resolving({ url: URL, keyPrefix })).toThrowError("`keyPrefix` must be a non-empty string");
});

test.for(["operationTimeout", "updateTagsTimeout", "maxTtl", "maxEntrySize"])(
  "a `%s` that is not a positive integer is an error naming it",
  (option) => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "60", null]) {
      expect(resolving({ url: URL, [option]: value })).toThrowError(
        `\`${option}\` must be a positive integer`,
      );
    }
  },
);

test.for(["onEvent", "onError"])(
  "a `%s` that is not a function is an error naming it",
  (option) => {
    expect(resolving({ url: URL, [option]: "log" })).toThrowError(
      `\`${option}\` must be a function`,
    );
  },
);

test("a `debug` that is not a boolean is an error naming it", () => {
  expect(resolving({ url: URL, debug: "true" })).toThrowError("`debug` must be a boolean");
});

test("the factory throws synchronously, before anything is built", () => {
  expect(() => createRedisCacheHandler({ url: "nowhere" })).toThrowError("`url` must be a");
});

/** A real node-redis client, never connected: what a caller would inject. */
function injectableClient(): RedisCacheHandlerOptions["client"] {
  return createClient({ url: URL });
}
