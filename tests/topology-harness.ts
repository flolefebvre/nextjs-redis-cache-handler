import { createClient } from "redis";
import { expect, onTestFinished, test } from "vitest";

import type { CacheClient } from "../src/client.js";
import { createRedisCacheHandler } from "../src/redis-cache-handler.js";
import type { CacheHandler } from "../src/types.js";
import {
  bytesOf,
  commandStream,
  entryOf,
  freshPrefix,
  readAfterRefresh,
  storeBefore,
  tagCommandNames,
  VALUE,
} from "./handler-harness.js";

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
