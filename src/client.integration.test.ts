import { randomUUID } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import { expect, inject, onTestFinished, test } from "vitest";

import { createRedisCacheHandler } from "./redis-cache-handler.js";

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGUSR2"] as const;

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
