import { createClient } from "redis";
import { expect, onTestFinished, test, vi } from "vitest";

import type { CacheClient } from "../src/client.js";
import { createRedisCacheHandler } from "../src/redis-cache-handler.js";
import { createCacheClient } from "../src/client.js";
import type { CacheEntry, CacheHandler } from "../src/types.js";
import {
  bytesOf,
  commandStream,
  entryOf,
  freshPrefix,
  readAfterRefresh,
  serverClient,
  storeBefore,
  tagCommandNames,
  VALUE,
} from "./handler-harness.js";
import { SENTINEL_MASTER_NAME, type RunningTopology } from "./redis-container.js";

/** A deployment one test file owns, and the client the handler is given for it. */
export interface Topology {
  /** The injected client, of whichever kind the file started a deployment for. */
  client: CacheClient;
  /** Every data node of the deployment, for the commands a test sends behind the client. */
  nodeUrls: string[];
}

/** One Instance on the given Key prefix, on an injected client, closed when the test ends. */
export function instanceOn(client: CacheClient, keyPrefix: string): CacheHandler {
  const handler = createRedisCacheHandler({ client, keyPrefix });
  onTestFinished(() => handler.close());

  return handler;
}

/**
 * Send one command to every data node of a deployment, on a connection of its own: what a
 * test uses to reach behind the client, to a node the client would never route it to.
 */
export async function onEveryNode(nodeUrls: string[], command: string[]): Promise<unknown[]> {
  return Promise.all(
    nodeUrls.map(async (url) => {
      const admin = createClient({ url });
      admin.on("error", () => undefined);
      await admin.connect();
      const reply = await admin.sendCommand(command).catch((error: unknown) => error);
      await admin.close().catch(() => undefined);

      return reply;
    }),
  );
}

/**
 * Watch every node of a deployment at once, and read back the names of the commands that
 * carried the Tag manifest, wherever they ran: a Cluster keeps that slot on one node of
 * three, and a Sentinel moves it to another server when the master changes, so which node
 * ran them is not something a cell can name in advance.
 */
export async function tagCommandsOn(
  keyPrefix: string,
  nodeUrls: string[],
): Promise<() => Promise<string[]>> {
  const streams = await Promise.all(nodeUrls.map((url) => commandStream(keyPrefix, url)));

  return async () => {
    const perNode = await Promise.all(streams.map((stream) => stream.settled()));

    return perNode.flatMap((commands) => tagCommandNames(commands, keyPrefix));
  };
}

/** What a test file's own client must offer for the harness to open and close it. */
interface ConnectableClient {
  on(event: "error", listener: () => void): unknown;
  connect(): Promise<unknown>;
}

/** The command every test sends to drop the connections a client holds to one node. */
export const KILL_CONNECTIONS = ["CLIENT", "KILL", "TYPE", "normal"];

/** How often a Sentinel is asked again whether it has a replica it would promote. */
const POLL_MS = 200;

/**
 * Wait until the Sentinel has a replica it would promote: one whose link to the master it
 * reports as up.
 *
 * A failover asked for before that view says `ok` is accepted, finds no replica it may
 * promote, and is abandoned on `failover-timeout` — no `topology-change` is emitted at
 * all, so a cell that asked for one and then waited for the promotion waits for something
 * that never comes. The view is the Sentinel's own and it refreshes it on its `INFO`
 * period, ten seconds, so it reports the stale `err` it last saw for that long after a
 * cell killed the connections on the data ports, the Sentinel's own links among them.
 * The deployment is not handed over until it says `ok` either, for the same reason.
 */
export async function promotableReplica(sentinelUrl: string): Promise<void> {
  const sentinel = await serverClient(sentinelUrl);

  await vi.waitUntil(
    async () => {
      const replicas = (await sentinel.sendCommand([
        "SENTINEL",
        "REPLICAS",
        SENTINEL_MASTER_NAME,
      ])) as Record<string, string>[];

      return replicas.some((replica) => replica["master-link-status"] === "ok");
    },
    { interval: POLL_MS },
  );
}

/** What a deployment showed of itself while a connection under it was rebuilt. */
export interface Disturbed {
  /** What the reader reads for the invalidated Entry once it has taken in the tag events. */
  entry: CacheEntry | undefined;
  /** The commands the Tag manifest and its log were carried by, over every node. */
  tagCommands: string[];
  /** How many rebuilt connections were counted while it happened. */
  rebuilds: number;
}

/**
 * Put two Instances of one app on either side of a disturbance, and hand back what the
 * deployment showed of it: whether the tag event one Instance wrote after it reached the
 * other, whether that Instance read the whole manifest to see it, and how many rebuilt
 * connections were counted on the way.
 *
 * The disturbance is the caller's — a killed connection, a failover — and so is the wait
 * for it to have happened: only the caller knows what its kind of client says when it has.
 * Everything around it is the same narrative whichever deployment is under it, which is
 * what makes the answers comparable.
 */
export async function acrossADisturbance(
  { client, nodeUrls }: Topology,
  disturb: () => Promise<void>,
): Promise<Disturbed> {
  const keyPrefix = freshPrefix();
  const handle = createCacheClient({ client }, () => undefined);
  const reader = instanceOn(client, keyPrefix);
  const writer = instanceOn(client, keyPrefix);
  await storeBefore(writer, "posts", { tags: ["posts"] });
  await reader.refreshTags();
  const counted = handle.reconnects();

  await disturb();

  const settled = await tagCommandsOn(keyPrefix, nodeUrls);
  await vi.waitFor(() => writer.updateTags(["posts"]));
  await reader.refreshTags();
  const disturbed = {
    entry: await reader.get("posts", []),
    tagCommands: await settled(),
    rebuilds: handle.reconnects() - counted,
  };
  await handle.close();

  return disturbed;
}

/**
 * A client one test file created, listened to and connected: node-redis crashes the
 * process on a client that has no `error` listener, and a test file's client is the one
 * thing here the handler does not attach one to itself.
 */
export async function connected<Client extends ConnectableClient>(client: Client): Promise<Client> {
  client.on("error", () => undefined);
  await client.connect();

  return client;
}

/** Close a client one test file created and take its deployment down. */
export async function stopped(
  client: { close(): Promise<void> },
  deployment: RunningTopology,
): Promise<void> {
  await client.close().catch(() => undefined);
  await deployment.stop();
}

/**
 * What an injected client of any kind owes the handler, asserted against a real deployment
 * of that kind: an Entry survives the round trip, a tag event one Instance writes reaches
 * another, and a server whose script cache was emptied is caught by the next call.
 *
 * It is one function rather than one copy per topology so that the two deployments are
 * held to the very same bar, and so that a cell added here is added to both.
 */
export function sharesTheStore(topology: () => Topology): void {
  test("an Entry one Instance writes is read back by another", async () => {
    const keyPrefix = freshPrefix();
    const { client } = topology();
    const writer = instanceOn(client, keyPrefix);
    const reader = instanceOn(client, keyPrefix);

    await writer.set("shared", Promise.resolve(entryOf()));

    const entry = await readAfterRefresh(reader, "shared");
    expect(await bytesOf(entry?.value ?? new ReadableStream())).toEqual(VALUE);
  });

  test("a tag event one Instance writes is seen by another after refreshTags", async () => {
    const keyPrefix = freshPrefix();
    const { client } = topology();
    const writer = instanceOn(client, keyPrefix);
    const reader = instanceOn(client, keyPrefix);
    await storeBefore(writer, "invalidated");
    expect(await readAfterRefresh(reader, "invalidated")).toBeDefined();

    await writer.updateTags(["posts"]);

    expect(await readAfterRefresh(reader, "invalidated")).toBeUndefined();
  });

  test("the scripts are sent again after every node's script cache was flushed", async () => {
    const keyPrefix = freshPrefix();
    const { client, nodeUrls } = topology();
    const instance = instanceOn(client, keyPrefix);
    await instance.set("flushed", Promise.resolve(entryOf()));

    expect(await onEveryNode(nodeUrls, ["SCRIPT", "FLUSH"])).toEqual(nodeUrls.map(() => "OK"));

    await instance.set("flushed", Promise.resolve(entryOf({ tags: [] })));
    await expect(instance.updateTags(["posts"])).resolves.toBeUndefined();
    const entry = await readAfterRefresh(instance, "flushed");
    expect(await bytesOf(entry?.value ?? new ReadableStream())).toEqual(VALUE);
  });
}
