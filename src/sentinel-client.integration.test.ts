import { createSentinel, type RedisSentinelType } from "redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { serverClient, wait } from "../tests/handler-harness.js";
import {
  providedRedisUrl,
  SENTINEL_MASTER_NAME,
  startSentinelRedis,
  testImage,
  type RunningSentinel,
} from "../tests/redis-container.js";
import {
  acrossADisturbance,
  connected,
  KILL_CONNECTIONS,
  onEveryNode,
  promotableReplica,
  sharesTheStore,
  stopped,
} from "../tests/topology-harness.js";

const DEPLOYMENT_TIMEOUT = 180_000;

const REBUILD_TIMEOUT = 60_000;

/** Long enough for a killed node connection to be dialled again once it was noticed. */
const REBUILT_MS = 500;

describe.skipIf(providedRedisUrl() !== undefined)("an injected Sentinel client", () => {
  let deployment: RunningSentinel;
  let client: RedisSentinelType;

  beforeAll(async () => {
    deployment = await startSentinelRedis(testImage());
    const { hostname, port } = new URL(deployment.sentinelUrl);
    client = await connected(
      createSentinel({
        name: SENTINEL_MASTER_NAME,
        sentinelRootNodes: [{ host: hostname, port: Number(port) }],
      }),
    );
  }, DEPLOYMENT_TIMEOUT);

  afterAll(() => stopped(client, deployment));

  sharesTheStore(() => ({ client, nodeUrls: deployment.nodeUrls }));

  test(
    "a connection rebuilt to the same master loses nothing, and is not counted",
    async () => {
      const topology = { client, nodeUrls: deployment.nodeUrls };

      const disturbed = await acrossADisturbance(topology, async () => {
        await onEveryNode(deployment.nodeUrls, KILL_CONNECTIONS);
        await wait(REBUILT_MS);
      });

      expect(disturbed.entry).toBeUndefined();
      expect(disturbed.tagCommands).not.toContain("HGETALL");
      expect(disturbed.rebuilds).toBe(0);
    },
    REBUILD_TIMEOUT,
  );

  test(
    "a failover is counted, and the next refresh reads the whole manifest off the new master",
    async () => {
      const topology = { client, nodeUrls: deployment.nodeUrls };

      const disturbed = await acrossADisturbance(topology, async () => {
        await promotableReplica(deployment.sentinelUrl);
        const sentinel = await serverClient(deployment.sentinelUrl);
        const promoted = new Promise((resolve) => client.once("topology-change", resolve));

        await sentinel.sendCommand(["SENTINEL", "FAILOVER", SENTINEL_MASTER_NAME]);
        await promoted;
      });

      expect(disturbed.entry).toBeUndefined();
      expect(disturbed.tagCommands).toContain("HGETALL");
      expect(disturbed.rebuilds).toBeGreaterThan(0);
    },
    REBUILD_TIMEOUT,
  );
});
