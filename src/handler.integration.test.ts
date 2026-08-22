import { expect, inject, onTestFinished, test, vi } from "vitest";

import { VALUE, entryOf, freshPrefix, serverClient, streamOf } from "../tests/handler-harness.js";
import type { CacheHandler } from "./types.js";

const VARIABLES = [
  "REDIS_URL",
  "NEXT_REDIS_CACHE_KEY_PREFIX",
  "NEXT_REDIS_CACHE_MAX_TTL",
  "NEXT_REDIS_CACHE_MAX_ENTRY_SIZE",
  "NEXT_REDIS_CACHE_OPERATION_TIMEOUT",
  "NEXT_REDIS_CACHE_UPDATE_TAGS_TIMEOUT",
  "NEXT_REDIS_CACHE_DEBUG",
];

const NO_TIME_AT_ALL = "1";

const NO_SERVER_THERE = "redis://127.0.0.1:1";

type ClosableHandler = CacheHandler & { close?: () => Promise<void> };

/**
 * The Node.js target of the Zero-config entry, loaded against the shared server of the run
 * and the given variables, and shut down when the test ends. `handler.ts` itself is a
 * re-export through a package self-reference, which resolves against the built output and
 * so cannot be loaded from source; `smoke:dist` is what covers that hop.
 */
async function entryWith(env: Record<string, string>): Promise<ClosableHandler> {
  for (const variable of VARIABLES) vi.stubEnv(variable, env[variable]);
  vi.stubEnv("REDIS_URL", env.REDIS_URL ?? inject("redisUrl"));
  vi.resetModules();
  const handler: ClosableHandler = (await import("./handler.node.js")).default;
  onTestFinished(async () => {
    await handler.close?.();
    vi.unstubAllEnvs();
  });

  return handler;
}

/** The console silenced for a test that means to make the handler fail. */
function silencedConsole(): void {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  onTestFinished(() => spy.mockRestore());
}

test("NEXT_REDIS_CACHE_KEY_PREFIX is the namespace the Entry is written under", async () => {
  const keyPrefix = freshPrefix();
  const handler = await entryWith({ NEXT_REDIS_CACHE_KEY_PREFIX: keyPrefix });
  const server = await serverClient();

  await handler.set("prefixed", Promise.resolve(entryOf()));

  expect(await server.type(`${keyPrefix}entry:prefixed`)).toBe("hash");
});

test("NEXT_REDIS_CACHE_MAX_TTL caps the Entry key's TTL, in seconds", async () => {
  const keyPrefix = freshPrefix();
  const handler = await entryWith({
    NEXT_REDIS_CACHE_KEY_PREFIX: keyPrefix,
    NEXT_REDIS_CACHE_MAX_TTL: "120",
  });
  const server = await serverClient();

  await handler.set("capped", Promise.resolve(entryOf({ expire: 900 })));

  expect(await server.ttl(`${keyPrefix}entry:capped`)).toBeGreaterThan(0);
  expect(await server.ttl(`${keyPrefix}entry:capped`)).toBeLessThanOrEqual(120);
});

test("NEXT_REDIS_CACHE_MAX_ENTRY_SIZE is the cap, in bytes, a larger Entry is skipped at", async () => {
  const keyPrefix = freshPrefix();
  const handler = await entryWith({
    NEXT_REDIS_CACHE_KEY_PREFIX: keyPrefix,
    NEXT_REDIS_CACHE_MAX_ENTRY_SIZE: String(VALUE.byteLength - 1),
  });
  const server = await serverClient();

  await handler.set("too-large", Promise.resolve(entryOf({ value: streamOf(VALUE) })));

  expect(await server.exists(`${keyPrefix}entry:too-large`)).toBe(0);
});

test("NEXT_REDIS_CACHE_OPERATION_TIMEOUT is the deadline, in milliseconds, a write gives up at", async () => {
  silencedConsole();
  const keyPrefix = freshPrefix();
  const handler = await entryWith({
    NEXT_REDIS_CACHE_KEY_PREFIX: keyPrefix,
    NEXT_REDIS_CACHE_OPERATION_TIMEOUT: NO_TIME_AT_ALL,
  });
  const server = await serverClient();

  await handler.set("timed-out", Promise.resolve(entryOf()));

  expect(await server.exists(`${keyPrefix}entry:timed-out`)).toBe(0);
});

test("NEXT_REDIS_CACHE_UPDATE_TAGS_TIMEOUT is the budget, in milliseconds, updateTags throws after", async () => {
  silencedConsole();
  const handler = await entryWith({
    REDIS_URL: NO_SERVER_THERE,
    NEXT_REDIS_CACHE_KEY_PREFIX: freshPrefix(),
    NEXT_REDIS_CACHE_UPDATE_TAGS_TIMEOUT: "200",
  });

  const startedAt = performance.now();
  await expect(handler.updateTags(["posts"])).rejects.toThrow();
  const spent = performance.now() - startedAt;

  expect(spent).toBeGreaterThanOrEqual(150);
  expect(spent).toBeLessThan(2_000);
});

test("NEXT_REDIS_CACHE_DEBUG logs every outcome to the console", async () => {
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
  onTestFinished(() => consoleLog.mockRestore());
  const handler = await entryWith({
    NEXT_REDIS_CACHE_KEY_PREFIX: freshPrefix(),
    NEXT_REDIS_CACHE_DEBUG: "true",
  });

  await handler.set("logged", Promise.resolve(entryOf()));

  expect(consoleLog.mock.calls.map(([line]) => String(line))).toContainEqual(
    expect.stringMatching(/\[nextjs-redis-cache-handler\].*set logged/),
  );
});

test("a Zero-config Instance reads what another Zero-config Instance wrote", async () => {
  const NEXT_REDIS_CACHE_KEY_PREFIX = freshPrefix();
  const writer = await entryWith({ NEXT_REDIS_CACHE_KEY_PREFIX });
  const reader = await entryWith({ NEXT_REDIS_CACHE_KEY_PREFIX });

  await writer.set("shared", Promise.resolve(entryOf()));
  await reader.refreshTags();

  expect(await reader.get("shared", [])).toBeDefined();
});
