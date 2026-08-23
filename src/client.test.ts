import { createClient, createCluster, createSentinel, defineScript } from "redis";
import { expect, test } from "vitest";

import { clientKind, reconnectDelay, type CacheClient } from "./client.js";
import type { CacheErrorOp } from "./events.js";
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
 * An injected client as the cells below hold one: what the handler is given, what a cell
 * emits on it, and the count of listeners it reads back off it.
 *
 * Every factory of the table states it as its return type, so that each concrete node-redis
 * client is checked against `CacheClient` where it is built, on its own. Left to infer, the
 * three would meet in one position and be weighed against each other instead — see the rule
 * in `docs/codebase/testing.md`.
 */
type InjectedClient = CacheClient & {
  emit(event: string, ...payload: unknown[]): boolean;
  listenerCount(event: string): number;
};

/** The failure of a node, as the payload of every kind's node-level event carries it. */
const NODE_FAILURE = new Error("boom");

/** The node those payloads name, as the kinds that name one spell it. */
const NODE = { host: "127.0.0.1", port: 6379 };

/**
 * One kind, as both cells below drive it: how a client of it is built, the event a rebuilt
 * connection is counted on, the node-level failure event it lets out with the payload
 * node-redis emits on it, and the message that failure reaches `onError` as.
 */
const KINDS = [
  {
    kind: "standalone",
    build: (): InjectedClient => createClient({ url: URL }),
    rebuilt: "reconnecting",
    failed: "error",
    payload: [NODE_FAILURE],
    reported: "boom",
  },
  {
    kind: "sentinel",
    build: (): InjectedClient =>
      createSentinel({ name: "mymaster", sentinelRootNodes: [SENTINEL_NODE] }),
    rebuilt: "client-error",
    failed: "client-error",
    payload: [{ type: "MASTER", node: NODE, error: NODE_FAILURE }],
    reported: "MASTER client (127.0.0.1:6379): boom",
  },
  {
    kind: "cluster",
    build: (): InjectedClient => createCluster({ rootNodes: [{ url: URL }] }),
    rebuilt: "node-reconnecting",
    failed: "node-error",
    payload: [NODE_FAILURE, NODE],
    reported: "Cluster node (127.0.0.1:6379): boom",
  },
] as const;

test.each(KINDS)(
  "the node failure an injected $kind client lets out is reported once, as an Error naming the node",
  async ({ build, failed, payload, reported }) => {
    const injected = build();
    const reports: [unknown, CacheErrorOp][] = [];
    const handler = createRedisCacheHandler({
      client: injected,
      keyPrefix: "cache-test:",
      onError: (error, op) => reports.push([error, op]),
    });

    injected.emit(failed, ...payload);
    await handler.close();

    expect(reports).toHaveLength(1);
    const [error, op] = reports[0] ?? [];
    expect(op).toBe("connect");
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(reported);
    expect((error as Error).cause ?? error).toBe(NODE_FAILURE);
  },
);

test.each(KINDS)(
  "an injected $kind client is listened to on the events its kind names, and is left as it was found",
  async ({ build, rebuilt, failed }) => {
    const injected = build();
    const events = [...new Set(["error", rebuilt, failed])];
    const counted = (): number[] => events.map((event) => injected.listenerCount(event));
    const before = counted();

    const handler = createRedisCacheHandler({ client: injected, keyPrefix: "cache-test:" });
    const attached = counted();
    await handler.close();

    const added = before.map((count, index) => (attached[index] ?? 0) - count);
    expect(Math.min(...added)).toBeGreaterThan(0);
    expect(counted()).toEqual(before);
  },
);
