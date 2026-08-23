import { createCluster } from "redis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { wait } from "../tests/handler-harness.js";
import {
  providedRedisUrl,
  startClusterRedis,
  testImage,
  type RunningTopology,
} from "../tests/redis-container.js";
import {
  acrossADisturbance,
  connected,
  KILL_CONNECTIONS,
  onEveryNode,
  reportsNodeFailures,
  sharesTheStore,
  stopped,
  type TopologyClient,
} from "../tests/topology-harness.js";

const DEPLOYMENT_TIMEOUT = 180_000;

const REBUILD_TIMEOUT = 60_000;

/** Long enough for a killed node connection to be dialled again once it was noticed. */
const REBUILT_MS = 200;

describe.skipIf(providedRedisUrl() !== undefined)("an injected Cluster client", () => {
  let deployment: RunningTopology;
  let client: TopologyClient;

  beforeAll(async () => {
    deployment = await startClusterRedis(testImage());
    client = await connected(
      createCluster({ rootNodes: deployment.nodeUrls.map((url) => ({ url })) }),
    );
  }, DEPLOYMENT_TIMEOUT);

  afterAll(() => stopped(client, deployment));

  sharesTheStore(() => ({ client, nodeUrls: deployment.nodeUrls }));

  reportsNodeFailures(() => ({ client, nodeUrls: deployment.nodeUrls }));

  test(
    "a node connection rebuilt is counted, so the next refresh reads the whole manifest",
    async () => {
      const topology = { client, nodeUrls: deployment.nodeUrls };

      const disturbed = await acrossADisturbance(topology, async () => {
        const rebuilt = new Promise((resolve) => client.once("node-reconnecting", resolve));
        await onEveryNode(deployment.nodeUrls, KILL_CONNECTIONS);
        await rebuilt;
        await wait(REBUILT_MS);
      });

      expect(disturbed.entry).toBeUndefined();
      expect(disturbed.tagCommands).toContain("HGETALL");
      expect(disturbed.rebuilds).toBeGreaterThan(0);
    },
    REBUILD_TIMEOUT,
  );
});
