import { randomUUID } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import { createClient } from "redis";
import { expect, inject, onTestFinished, test, vi } from "vitest";

import { opsOf, recording, serverClient } from "../tests/handler-harness.js";
import { stopwatch } from "../tests/unit-harness.js";
import { createCacheClient, type CacheClient, type CacheCommands } from "./client.js";
import { createRedisCacheHandler } from "./redis-cache-handler.js";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGUSR2"] as const;

/** A retry budget short enough that a write which can only fail is not waited out. */
const RETRY_BUDGET = 200;

/** How long a handshake nothing answers may hold the socket: the client's idle timeout. */
const HANDSHAKE_BOUND = 15_000;

/** What a loaded host may add to it, and still be nowhere near the 30 s of a default client. */
const NOTICE_MARGIN = 8_000;

/** A deadline long enough to tell an operation waiting on the handshake from one failing at once. */
const PATIENT_TIMEOUT = 2_000;

/** What "at once" means for an operation that has nothing left to wait on. */
const PROMPT_MS = 500;

/** How often a cell asks again while it waits for the client to notice. */
const POLL_MS = 50;

/** The failure a handler hands back when its client has no connection, which a read reads as `unavailable`. */
const NOT_CONNECTED = /not connected/;

function freshPrefix(): string {
  return `cache-test:${randomUUID()}:`;
}

async function countingListener() {
  const sockets: Socket[] = [];
  const server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `redis://127.0.0.1:${String(port)}`,
    connections: () => sockets.length,
    knock: () =>
      new Promise<void>((resolve) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.destroy();
          setTimeout(resolve, 20);
        });
      }),
  };
}

function entry() {
  return Promise.resolve({
    value: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([7]));
        controller.close();
      },
    }),
    tags: [],
    stale: 30,
    timestamp: Date.now(),
    expire: 60,
    revalidate: 30,
  });
}

test("nothing connects before the first operation", async () => {
  const listener = await countingListener();
  const unused = createRedisCacheHandler({ url: listener.url, keyPrefix: freshPrefix() });

  await unused.close();

  expect(listener.connections()).toBe(0);
  await listener.knock();
  expect(listener.connections()).toBe(1);
});

test("close() returns while a connection to an unresponsive server is still pending", async () => {
  const listener = await countingListener();
  const handler = createRedisCacheHandler({ url: listener.url, keyPrefix: freshPrefix() });

  const refreshing = handler.refreshTags();
  await vi.waitUntil(() => listener.connections() > 0);
  await expect(handler.close()).resolves.toBeUndefined();

  await expect(refreshing).resolves.toBeUndefined();
  expect(await handler.get("anything", [])).toBeUndefined();
});

/**
 * A TCP accept followed by silence — a proxy or a port forwarder in front of a dead server
 * — is not a failed connection: node-redis sends `HELLO` and waits, and only the idle
 * timeout tears the socket down. Until it does, every operation spends its whole deadline;
 * after it, the client has been seen failing and each one is handed the not-connected
 * error at once, which a read reports as a miss `unavailable`.
 */
test(
  "an operation against a silent handshake stops waiting out its deadline within the bound",
  { timeout: HANDSHAKE_BOUND + NOTICE_MARGIN + PATIENT_TIMEOUT * 4 },
  async () => {
    const listener = await countingListener();
    const recorded = recording();
    const handler = createRedisCacheHandler({
      url: listener.url,
      keyPrefix: freshPrefix(),
      operationTimeout: PATIENT_TIMEOUT,
      ...recorded.hooks,
    });
    onTestFinished(() => handler.close());

    const first = stopwatch();
    await handler.refreshTags();
    const waitedMs = first();
    const elapsed = stopwatch();
    await vi.waitUntil(
      async () => {
        const attempt = stopwatch();
        await handler.refreshTags();

        return attempt() < PROMPT_MS;
      },
      { timeout: HANDSHAKE_BOUND + NOTICE_MARGIN, interval: POLL_MS },
    );
    const noticedMs = elapsed();

    const refreshFailures = recorded.errors
      .filter(([, op]) => op === "refreshTags")
      .map(([error]) => String(error));
    expect(waitedMs).toBeGreaterThanOrEqual(PATIENT_TIMEOUT - POLL_MS);
    expect(noticedMs).toBeLessThan(HANDSHAKE_BOUND + NOTICE_MARGIN);
    expect(refreshFailures.at(-1)).toMatch(NOT_CONNECTED);
  },
);

test("close() resolves on a handler that has read and written", async () => {
  const handler = createRedisCacheHandler({ url: inject("redisUrl"), keyPrefix: freshPrefix() });

  await handler.set("closing", entry());
  await handler.get("closing", []);

  await expect(handler.close()).resolves.toBeUndefined();
});

test("the handler installs no process signal handler", async () => {
  const before = SIGNALS.map((signal) => process.listenerCount(signal));

  const handler = createRedisCacheHandler({ url: inject("redisUrl"), keyPrefix: freshPrefix() });
  await handler.set("listeners", entry());
  await handler.get("listeners", []);
  await handler.close();

  expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
});

test("an injected client round-trips an Entry, and is left open by close()", async () => {
  const injected = await serverClient();
  const handler = createRedisCacheHandler({ client: injected, keyPrefix: freshPrefix() });

  await handler.set("injected", entry());
  await handler.refreshTags();
  const stored = await handler.get("injected", []);
  await handler.close();

  expect(stored).toBeDefined();
  expect(await injected.ping()).toBe("PONG");
});

test("an injected client that is not connected is never connected by the handler", async () => {
  const listener = await countingListener();
  const injected = createClient({ url: listener.url });
  const recorded = recording();
  const handler = createRedisCacheHandler({
    client: injected,
    keyPrefix: freshPrefix(),
    updateTagsTimeout: RETRY_BUDGET,
    ...recorded.hooks,
  });

  await handler.refreshTags();
  await handler.set("offline", entry());
  const read = await handler.get("offline", []);
  await expect(handler.updateTags(["posts"])).rejects.toThrowError();

  expect(read).toBeUndefined();
  expect(opsOf(recorded.errors)).toEqual(["refreshTags", "set", "updateTags"]);
  expect(injected.isOpen).toBe(false);
  expect(listener.connections()).toBe(0);
  await handler.close();
  expect(injected.isOpen).toBe(false);
  expect(listener.connections()).toBe(0);
});

test("close() takes the handler's error listener off an injected client", async () => {
  const injected = await serverClient();
  const recorded = recording();
  const handler = createRedisCacheHandler({
    client: injected,
    keyPrefix: freshPrefix(),
    ...recorded.hooks,
  });

  injected.emit("error", new Error("while the handler is open"));
  await handler.close();
  injected.emit("error", new Error("after the handler closed"));

  expect(opsOf(recorded.errors)).toEqual(["connect"]);
});

test("close() leaves an injected client with no listener of the handler's on it", async () => {
  const injected = await serverClient();
  const before = ["error", "reconnecting"].map((event) => injected.listenerCount(event));
  const handler = createRedisCacheHandler({ client: injected, keyPrefix: freshPrefix() });

  await handler.close();

  expect(["error", "reconnecting"].map((event) => injected.listenerCount(event))).toEqual(before);
});

test("close() quits a client the handler created from a url", async () => {
  const handle = createCacheClient({ url: inject("redisUrl") }, () => undefined);
  const client = await handle.connected();
  expect(await ping(client)).toBe("PONG");

  await handle.close();

  await expect(ping(client)).rejects.toThrowError();
});

/** A round trip on a client the handler built itself, which is a standalone one. */
function ping(client: CacheClient): Promise<unknown> {
  return (client.withTypeMapping({}) as CacheCommands).sendCommand(["PING"]);
}
