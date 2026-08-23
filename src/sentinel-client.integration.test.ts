import { createSentinel, type RedisSentinelType } from "redis";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { freshPrefix, serverClient, storeBefore, wait } from "../tests/handler-harness.js";
import {
  providedRedisUrl,
  startSentinelRedis,
  testImage,
  type RunningSentinel,
} from "../tests/redis-container.js";
import {
  instanceOn,
  onEveryNode,
  sharesTheStore,
  tagCommandsOn,
} from "../tests/topology-harness.js";
import { createCacheClient } from "./client.js";

const MASTER_NAME = "mymaster";

const DEPLOYMENT_TIMEOUT = 180_000;

const REBUILD_TIMEOUT = 60_000;

/** Long enough for a killed node connection to be noticed and dialled again. */
const REBUILT_MS = 500;

describe.skipIf(providedRedisUrl() !== undefined)("an injected Sentinel client", () => {
  let deployment: RunningSentinel;
  let client: RedisSentinelType;

  beforeAll(async () => {
    deployment = await startSentinelRedis(testImage());
    const { hostname, port } = new URL(deployment.sentinelUrl);
    client = createSentinel({
      name: MASTER_NAME,
      sentinelRootNodes: [{ host: hostname, port: Number(port) }],
    });
    client.on("error", () => undefined);
    await client.connect();
  }, DEPLOYMENT_TIMEOUT);

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await deployment.stop();
  });

  sharesTheStore(() => ({ client, nodeUrls: deployment.nodeUrls }));

  test(
    "a connection rebuilt to the same master is not counted, and the next refresh resumes where it was",
    async () => {
      const keyPrefix = freshPrefix();
      const handle = createCacheClient({ client }, () => undefined);
      const reader = instanceOn(client, keyPrefix);
      const writer = instanceOn(client, keyPrefix);
      await storeBefore(writer, "posts", { tags: ["posts"] });
      await reader.refreshTags();
      const counted = handle.reconnects();

      await onEveryNode(deployment.nodeUrls, ["CLIENT", "KILL", "TYPE", "normal"]);
      await wait(REBUILT_MS);
      const settled = await tagCommandsOn(keyPrefix, deployment.nodeUrls);
      await vi.waitFor(() => writer.updateTags(["posts"]));
      await reader.refreshTags();

      expect(await reader.get("posts", [])).toBeUndefined();
      expect(await settled()).not.toContain("HGETALL");
      expect(handle.reconnects()).toBe(counted);
      await handle.close();
    },
    REBUILD_TIMEOUT,
  );

  test(
    "a failover is counted, and the next refresh reads the whole manifest off the new master",
    async () => {
      const keyPrefix = freshPrefix();
      const handle = createCacheClient({ client }, () => undefined);
      const reader = instanceOn(client, keyPrefix);
      const writer = instanceOn(client, keyPrefix);
      await storeBefore(writer, "posts", { tags: ["posts"] });
      await reader.refreshTags();
      const counted = handle.reconnects();
      const promoted = new Promise((resolve) => client.once("topology-change", resolve));
      const sentinel = await serverClient(deployment.sentinelUrl);

      await sentinel.sendCommand(["SENTINEL", "FAILOVER", MASTER_NAME]);
      await promoted;
      const settled = await tagCommandsOn(keyPrefix, deployment.nodeUrls);
      await vi.waitFor(() => writer.updateTags(["posts"]));
      await reader.refreshTags();

      expect(await reader.get("posts", [])).toBeUndefined();
      expect(await settled()).toContain("HGETALL");
      expect(handle.reconnects()).toBeGreaterThan(counted);
      await handle.close();
    },
    REBUILD_TIMEOUT,
  );
});
