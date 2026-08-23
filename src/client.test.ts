import { createClient, createCluster, createSentinel, defineScript } from "redis";
import { expect, test } from "vitest";

import { clientKind, reconnectDelay, type CacheClient } from "./client.js";
import { createRedisCacheHandler } from "./redis-cache-handler.js";

/** A server nothing dials: every client here is built, never connected. */
const URL = "redis://127.0.0.1:6379";

/** The same server, as a Sentinel's root nodes name one. */
const SENTINEL_NODE = { host: "127.0.0.1", port: 26_379 };

const CAP_WITH_JITTER = 2_200;

test("the first attempts back off, from 50 ms up", () => {
  expect(reconnectDelay(0)).toBeGreaterThanOrEqual(50);
  expect(reconnectDelay(0)).toBeLessThan(reconnectDelay(5));
});

test("every attempt count, however large, is a bounded delay and never a refusal", () => {
  for (const retries of [0, 1, 10, 53, 1_024, 1e6, Number.MAX_SAFE_INTEGER]) {
    const delay: unknown = reconnectDelay(retries);

    expect(typeof delay).toBe("number");
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(CAP_WITH_JITTER);
  }
});

test("a standalone client is one, whatever generic parameters it carries", () => {
  const plain: CacheClient = createClient({ url: URL });
  const tuned: CacheClient = createClient({
    url: URL,
    RESP: 2,
    scripts: {
      answer: defineScript({
        SCRIPT: "return 42",
        NUMBER_OF_KEYS: 0,
        parseCommand(parser) {
          parser.push("42");
        },
        transformReply: undefined as unknown as () => number,
      }),
    },
  });

  expect([clientKind(plain), clientKind(tuned)]).toEqual(["standalone", "standalone"]);
});

test("a Sentinel client is one, and is told apart from a Cluster client", () => {
  const sentinel: CacheClient = createSentinel({
    name: "mymaster",
    sentinelRootNodes: [SENTINEL_NODE],
  });
  const cluster: CacheClient = createCluster({ rootNodes: [{ url: URL }] });

  expect([clientKind(sentinel), clientKind(cluster)]).toEqual(["sentinel", "cluster"]);
});

/**
 * An injected client as the cell below holds one: what the handler is given, and the count
 * of listeners the cell reads back off it.
 *
 * Every factory of the table states it as its return type, so that each concrete node-redis
 * client is checked against `CacheClient` where it is built, on its own. Left to infer, the
 * three would meet in one position and be weighed against each other instead — see the rule
 * in `docs/codebase/testing.md`.
 */
type InjectedClient = CacheClient & { listenerCount(event: string): number };

test.each([
  ["standalone", (): InjectedClient => createClient({ url: URL }), "reconnecting"],
  [
    "sentinel",
    (): InjectedClient => createSentinel({ name: "mymaster", sentinelRootNodes: [SENTINEL_NODE] }),
    "client-error",
  ],
  [
    "cluster",
    (): InjectedClient => createCluster({ rootNodes: [{ url: URL }] }),
    "node-reconnecting",
  ],
] as const)(
  "an injected %s client is listened to on the event its kind names, and is left as it was found",
  async (_kind, build, rebuilt) => {
    const injected = build();
    const events = ["error", rebuilt];
    const before = events.map((event) => injected.listenerCount(event));

    const handler = createRedisCacheHandler({ client: injected, keyPrefix: "cache-test:" });
    const attached = events.map((event) => injected.listenerCount(event));
    await handler.close();

    expect(attached).toEqual(before.map((count) => count + 1));
    expect(events.map((event) => injected.listenerCount(event))).toEqual(before);
  },
);
