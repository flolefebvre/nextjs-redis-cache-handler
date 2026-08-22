import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";

import type { CacheEntry, CacheHandler } from "./types.js";

const VARIABLES = [
  "REDIS_URL",
  "NEXT_REDIS_CACHE_KEY_PREFIX",
  "NEXT_REDIS_CACHE_MAX_TTL",
  "NEXT_REDIS_CACHE_MAX_ENTRY_SIZE",
  "NEXT_REDIS_CACHE_OPERATION_TIMEOUT",
  "NEXT_REDIS_CACHE_UPDATE_TAGS_TIMEOUT",
  "NEXT_REDIS_CACHE_DEBUG",
];

const METHODS = ["get", "set", "refreshTags", "getExpiration", "updateTags"];

const UNREACHABLE = "redis://127.0.0.1:6379";

type ClosableHandler = CacheHandler & { close?: () => Promise<void> };

/**
 * The Node.js target of the Zero-config entry, loaded again against nothing but the given
 * environment. `handler.ts` itself is a re-export through a package self-reference, which
 * only a real Node.js resolver follows; `smoke:dist` is what covers that hop.
 */
async function loadEntry(env: Record<string, string> = {}): Promise<ClosableHandler> {
  for (const variable of VARIABLES) vi.stubEnv(variable, env[variable]);
  vi.resetModules();

  return (await import("./handler.node.js")).default;
}

function entryOf(): Promise<CacheEntry> {
  return Promise.resolve({
    value: new ReadableStream<Uint8Array>(),
    tags: [],
    stale: 0,
    timestamp: Date.now(),
    expire: 900,
    revalidate: 60,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

test("the entry is one plain object with the five methods and no default property", async () => {
  const handler = await loadEntry({ REDIS_URL: UNREACHABLE });

  expect(typeof handler).toBe("object");
  expect(
    METHODS.filter((method) => typeof handler[method as keyof CacheHandler] === "function"),
  ).toEqual(METHODS);
  expect(handler).not.toHaveProperty("default");
});

test("with no REDIS_URL the entry loads, misses, drops writes and says so exactly once", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const handler = await loadEntry();

  await handler.refreshTags();
  await handler.set("key", entryOf());
  const [first, second] = [await handler.get("key", []), await handler.get("other", [])];
  await handler.updateTags(["posts"]);
  await handler.getExpiration(["posts"]);

  expect([first, second]).toEqual([undefined, undefined]);
  expect(consoleError).toHaveBeenCalledOnce();
  expect(String(consoleError.mock.calls[0]?.[0])).toMatch(/REDIS_URL.*disabled/s);
});

test("a variable holding a value nobody can parse fails the load, naming the variable", async () => {
  const unusable: Record<string, string> = {
    NEXT_REDIS_CACHE_MAX_TTL: "abc",
    NEXT_REDIS_CACHE_MAX_ENTRY_SIZE: "1.5",
    NEXT_REDIS_CACHE_OPERATION_TIMEOUT: "1e3",
    NEXT_REDIS_CACHE_UPDATE_TAGS_TIMEOUT: "-1",
    NEXT_REDIS_CACHE_DEBUG: "yes",
  };

  for (const [variable, value] of Object.entries(unusable)) {
    await expect(loadEntry({ REDIS_URL: UNREACHABLE, [variable]: value })).rejects.toThrow(
      new RegExp(`\`${variable}\``),
    );
  }
});

test("a value the factory refuses fails the load too, naming the option it maps to", async () => {
  const refused: Record<string, string> = {
    NEXT_REDIS_CACHE_MAX_TTL: "0",
    NEXT_REDIS_CACHE_MAX_ENTRY_SIZE: "0",
    NEXT_REDIS_CACHE_OPERATION_TIMEOUT: "0",
    NEXT_REDIS_CACHE_UPDATE_TAGS_TIMEOUT: "0",
  };

  for (const [variable, value] of Object.entries(refused)) {
    await expect(loadEntry({ REDIS_URL: UNREACHABLE, [variable]: value })).rejects.toThrow(
      /must be a positive integer/,
    );
  }
});

test("a REDIS_URL that is no Redis URL fails the load, naming the option", async () => {
  await expect(loadEntry({ REDIS_URL: "http://localhost:6379" })).rejects.toThrow(/`url`/);
});

test("loading the entry opens no connection, the first operation does", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const connections: unknown[] = [];
  const server = createServer((socket) => connections.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const handler = await loadEntry({
    REDIS_URL: `redis://127.0.0.1:${String(port)}`,
    NEXT_REDIS_CACHE_OPERATION_TIMEOUT: "100",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const openedByTheImport = connections.length;
  await handler.refreshTags();
  await handler.close?.();
  server.close();
  for (const socket of connections) (socket as { destroy(): void }).destroy();

  expect(openedByTheImport).toBe(0);
  expect(connections.length).toBeGreaterThan(0);
});
