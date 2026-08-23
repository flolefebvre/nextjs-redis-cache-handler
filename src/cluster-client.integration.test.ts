import { createCluster, type RedisClusterType } from "redis";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { freshPrefix, storeBefore, wait } from "../tests/handler-harness.js";
import {
  providedRedisUrl,
  startClusterRedis,
  testImage,
  type RunningTopology,
} from "../tests/redis-container.js";
import {
  instanceOn,
  onEveryNode,
  sharesTheStore,
  tagCommandsOn,
} from "../tests/topology-harness.js";

const DEPLOYMENT_TIMEOUT = 180_000;

const REBUILD_TIMEOUT = 30_000;

/** Long enough for a killed node connection to be noticed and dialled again. */
const REBUILT_MS = 200;

describe.skipIf(providedRedisUrl() !== undefined)("an injected Cluster client", () => {
  let deployment: RunningTopology;
  let client: RedisClusterType;

  beforeAll(async () => {
    deployment = await startClusterRedis(testImage());
    client = createCluster({ rootNodes: deployment.nodeUrls.map((url) => ({ url })) });
    client.on("error", () => undefined);
    await client.connect();
  }, DEPLOYMENT_TIMEOUT);

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await deployment.stop();
  });

  sharesTheStore(() => ({
    client: client,
    nodeUrls: deployment.nodeUrls,
  }));

  test(
    "a node connection rebuilt is counted, so the next refresh reads the whole manifest",
    async () => {
      const keyPrefix = freshPrefix();
      const reader = instanceOn(client, keyPrefix);
      const writer = instanceOn(client, keyPrefix);
      await storeBefore(writer, "posts", { tags: ["posts"] });
      await reader.refreshTags();
      const rebuilt = new Promise((resolve) => client.once("node-reconnecting", resolve));

      await onEveryNode(deployment.nodeUrls, ["CLIENT", "KILL", "TYPE", "normal"]);
      await rebuilt;
      await wait(REBUILT_MS);
      const settled = await tagCommandsOn(keyPrefix, deployment.nodeUrls);
      await vi.waitFor(() => writer.updateTags(["posts"]));
      await reader.refreshTags();

      expect(await reader.get("posts", [])).toBeUndefined();
      expect(await settled()).toContain("HGETALL");
    },
    REBUILD_TIMEOUT,
  );
});
