import { createSentinel } from "redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { wait } from "../tests/handler-harness.js";
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
  failedOver,
  onEveryNode,
  reportsNodeFailures,
  SentinelTiltError,
  sharesTheStore,
  stopped,
  type TopologyClient,
} from "../tests/topology-harness.js";

const DEPLOYMENT_TIMEOUT = 180_000;

const REBUILD_TIMEOUT = 60_000;

/** What a failover may take here: every attempt of `failedOver`, and the cell around them. */
const FAILOVER_TIMEOUT = 90_000;

/** Long enough for a killed node connection to be dialled again once it was noticed. */
const REBUILT_MS = 500;

describe.skipIf(providedRedisUrl() !== undefined)("an injected Sentinel client", () => {
  let deployment: RunningSentinel;
  let client: TopologyClient;
  let passthrough: TopologyClient;

  beforeAll(async () => {
    deployment = await startSentinelRedis(testImage());
    const { hostname, port } = new URL(deployment.sentinelUrl);
    client = await connected(
      createSentinel({
        name: SENTINEL_MASTER_NAME,
        sentinelRootNodes: [{ host: hostname, port: Number(port) }],
      }),
    );
    passthrough = await connected(
      createSentinel({
        name: SENTINEL_MASTER_NAME,
        sentinelRootNodes: [{ host: hostname, port: Number(port) }],
        passthroughClientErrorEvents: true,
      }),
    );
  }, DEPLOYMENT_TIMEOUT);

  afterAll(async () => {
    await passthrough.close().catch(() => undefined);
    await stopped(client, deployment);
  });

  sharesTheStore(() => ({ client, nodeUrls: deployment.nodeUrls }));

  reportsNodeFailures(() => ({ client: passthrough, nodeUrls: deployment.nodeUrls }));

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
    async ({ skip }) => {
      const topology = { client, nodeUrls: deployment.nodeUrls };

      const disturbed = await acrossADisturbance(topology, () =>
        failedOver(deployment.sentinelUrl, client),
      ).catch((error: unknown) => {
        if (error instanceof SentinelTiltError) skip(error.message);

        throw error;
      });

      expect(disturbed.entry).toBeUndefined();
      expect(disturbed.tagCommands).toContain("HGETALL");
      expect(disturbed.rebuilds).toBeGreaterThan(0);
    },
    FAILOVER_TIMEOUT,
  );
});
