import { createClient } from "redis";
import { expect, onTestFinished, test, vi } from "vitest";

import type { CacheClient } from "../src/client.js";
import { entryKey } from "../src/entry-store.js";
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
  type ServerClient,
  storeBefore,
  tagCommandNames,
  VALUE,
} from "./handler-harness.js";
import { SENTINEL_MASTER_NAME, type RunningTopology } from "./redis-container.js";
import { stopwatch } from "./unit-harness.js";

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
 * Watch every node of a deployment at once, on a connection per node, and read back what
 * each of them ran on one Key prefix, the node it ran on beside it.
 *
 * Which node runs what is not something a cell can name in advance: a Cluster keeps one
 * slot on one node of three, a Sentinel moves the master to another server when it fails
 * over, and a client the caller configured to read replicas sends its reads somewhere else
 * again. So every node is watched, and what a cell asks of the answer is its own.
 */
async function commandsPerNode(
  keyPrefix: string,
  nodeUrls: string[],
): Promise<() => Promise<[string, string[][]][]>> {
  const streams = await Promise.all(
    nodeUrls.map(async (url) => [url, await commandStream(keyPrefix, url)] as const),
  );

  return async () =>
    Promise.all(
      streams.map(async ([url, stream]) => [url, await stream.settled()] as [string, string[][]]),
    );
}

/**
 * The names of the commands that carried the Tag manifest, wherever they ran: the manifest
 * lives on one node of a deployment and which one is not a cell's to know, so the names
 * come back pooled over every node.
 */
export async function tagCommandsOn(
  keyPrefix: string,
  nodeUrls: string[],
): Promise<() => Promise<string[]>> {
  const settled = await commandsPerNode(keyPrefix, nodeUrls);

  return async () =>
    (await settled()).flatMap(([, commands]) => tagCommandNames(commands, keyPrefix));
}

/** The command an Entry is read with, as `MONITOR` names it whatever started it. */
const ENTRY_READ = "HGETALL";

/**
 * The nodes an Entry of this Key prefix was read on, named by the read alone: a write is
 * carried to a replica over the replication link and shows up in its stream too, so a node
 * that only ever took the Entry over replication is not one the Entry was read on.
 */
export async function entryReadsOn(
  keyPrefix: string,
  nodeUrls: string[],
): Promise<() => Promise<string[]>> {
  const settled = await commandsPerNode(keyPrefix, nodeUrls);

  return async () =>
    (await settled())
      .filter(([, commands]) => commands.some((command) => isEntryRead(command, keyPrefix)))
      .map(([url]) => url);
}

function isEntryRead(command: string[], keyPrefix: string): boolean {
  const [name, key] = command;

  return name?.toUpperCase() === ENTRY_READ && (key ?? "").startsWith(entryKey(keyPrefix, ""));
}

/** What a server says of itself when it is a node of a Cluster, and nothing else does. */
const CLUSTER_ENABLED = "cluster_enabled:1";

/**
 * The node a deployment would send a write of one key to, asked of the deployment itself
 * rather than assumed by the caller.
 *
 * Which node that is has an answer only at the moment it is asked, and the question is not
 * the same one on every deployment: a Sentinel keeps one master and promotes its replica
 * onto another server, a Cluster keeps one master per slot and the key alone says which
 * slot. So the deployment is asked what it is — only a Cluster node reports
 * `cluster_enabled:1` — and then asked its own form of the question, in the same spirit as
 * `commandsPerNode`: a cell names the key it cares about and stays ignorant of which
 * deployment it is running on.
 */
export async function masterOf(key: string, nodeUrls: string[]): Promise<string> {
  const node = await serverClient(nodeUrls[0]);
  const info = String(await node.sendCommand(["INFO"]));

  return info.includes(CLUSTER_ENABLED) ? slotMaster(node, key, nodeUrls) : soleMaster(nodeUrls);
}

/** One slot range of `CLUSTER SLOTS`: the slots it covers, then its master's address. */
type SlotRange = [number, number, [string, number, ...unknown[]], ...unknown[]];

/**
 * The master of the slot a key hashes to, read off the routing view every client builds its
 * own from, and named back as the `nodeUrls` entry it is: an address the deployment
 * announces is one the tests dial, which is what `--cluster-announce-ip` and the matching
 * host and container ports are for.
 */
async function slotMaster(node: ServerClient, key: string, nodeUrls: string[]): Promise<string> {
  const slot = Number(await node.sendCommand(["CLUSTER", "KEYSLOT", key]));
  const ranges = (await node.sendCommand(["CLUSTER", "SLOTS"])) as SlotRange[];
  const owner = ranges.find(([from, to]) => slot >= from && slot <= to);
  if (owner === undefined) throw new Error(`no node owns slot ${String(slot)}`);

  const [host, port] = owner[2];
  const url = `redis://${host}:${String(port)}`;
  if (!nodeUrls.includes(url)) throw new Error(`slot ${String(slot)} is owned by ${url}`);

  return url;
}

/** The one node of a single-master deployment reporting itself a master right now. */
async function soleMaster(nodeUrls: string[]): Promise<string> {
  const replication = await onEveryNode(nodeUrls, ["INFO", "replication"]);
  const masters = nodeUrls.filter((_, index) => String(replication[index]).includes("role:master"));
  if (masters.length !== 1) throw new Error(`the deployment has ${String(masters.length)} masters`);

  return masters[0] ?? "";
}

/**
 * The client of one deployment, as the test file that created it holds it: what the handler
 * is given, and what the file itself does with it — open it, await one event of it, and
 * close it when its deployment goes down.
 *
 * The file states it rather than the concrete node-redis type its factory returns, so that
 * the concrete client is checked against `CacheClient` once, where it is built — see the
 * rule in `docs/codebase/testing.md`.
 */
export type TopologyClient = CacheClient & {
  on(event: "error", listener: () => void): unknown;
  once(event: string, listener: (payload: unknown) => void): unknown;
  connect(): Promise<unknown>;
  close(): Promise<void>;
};

/** The command every test sends to drop the connections a client holds to one node. */
export const KILL_CONNECTIONS = ["CLIENT", "KILL", "TYPE", "normal"];

/** How often a Sentinel is asked again whether it has a replica it would promote. */
const POLL_MS = 200;

/**
 * How long that wait may take: longer than the Sentinel's `INFO` period with margin, since
 * the stale view it waits out lasts up to that period.
 */
const PROMOTABLE_TIMEOUT_MS = 15_000;

/**
 * How long a failover is asked for, over as many attempts as it takes: one TILT period and
 * a margin. It is enough to wait out a single step of the host's clock, and deliberately
 * not enough to wait out a bout of them — a Sentinel put back into TILT every step is one
 * no failover completes on, which is a property of the host and not something a longer
 * budget reaches.
 */
const FAILOVER_BUDGET_MS = 45_000;

/**
 * How long one attempt waits for the promotion: the deployment's `failover-timeout`, past
 * which an unfinished failover is abandoned, and a margin. Waiting longer would only be
 * waiting on an attempt that has already been given up on.
 */
const PROMOTION_MS = 8_000;

const FAILOVER_IN_PROGRESS = "INPROG";

const NO_PROMOTABLE_REPLICA = "NOGOODSLAVE";

/**
 * A failover that could not complete because the Sentinel is in TILT: not a failure of
 * anything under test, and the one outcome a cell is allowed to skip itself on.
 */
export class SentinelTiltError extends Error {
  constructor() {
    super(
      "the Sentinel is in TILT and completes no failover: this host steps its wall clock, " +
        "and a Sentinel whose cron sees a step suspends every failover action for thirty " +
        "seconds. A host whose clock holds still — CI's — runs this through.",
    );
    this.name = "SentinelTiltError";
  }
}

/** What `failedOver` needs of a client: the one event a promotion reaches it by. */
export interface PromotedClient {
  once(event: "topology-change", listener: () => void): unknown;
  off(event: "topology-change", listener: () => void): unknown;
}

/**
 * Wait until the Sentinel has a replica it would promote: one whose link to the master it
 * reports as up.
 *
 * A failover asked for before that view says `ok` is accepted, finds no replica it may
 * promote, and is abandoned on `failover-timeout` — no `topology-change` is emitted at
 * all, so a cell that asked for one and then waited for the promotion waits for something
 * that never comes. The view is the Sentinel's own and it refreshes it on its `INFO`
 * period, ten seconds, so it reports the stale `err` it last saw for that long after a
 * cell killed the connections on the data ports, the Sentinel's own links among them —
 * which is why the wait is given a deadline that outlasts that period rather than the
 * one-second default, that being the very window it exists to wait out. The deployment is
 * not handed over until it says `ok` either, for the same reason.
 */
export async function promotableReplica(sentinelUrl: string): Promise<void> {
  const sentinel = await serverClient(sentinelUrl);

  await vi.waitUntil(() => promotable(sentinel), {
    interval: POLL_MS,
    timeout: PROMOTABLE_TIMEOUT_MS,
  });
}

/**
 * Fail one Sentinel deployment over, and come back when the client has been told: ask for
 * the failover, wait for the `topology-change` a completed one publishes, and ask again
 * for as long as the budget lasts.
 *
 * The retrying is TILT, and TILT is why nothing here waits on a delay. A Sentinel whose
 * cron sees the wall clock go backwards, or jump forward by more than two seconds, decides
 * it cannot trust its own timings and enters TILT: it keeps observing but suspends every
 * failover action for thirty seconds. A failover in flight when that happens is left where
 * it stands, exceeds its `failover-timeout` and is abandoned — the replica may already have
 * been told to become a master, but `+switch-master` is never published, so the client is
 * never told and a cell waiting for the event waits for one that will not come. This host's
 * clock steps, so this is not a rare case here, and a second attempt asked for while TILT
 * still holds is answered `INPROG` for the failover that is still pending. So an attempt is
 * made only while `INFO sentinel` reports `sentinel_tilt:0` and a replica is promotable,
 * `INPROG` is read as "not yet" rather than as a failure — as is `NOGOODSLAVE`, which `ask`
 * covers for a reason of its own — and every attempt is bounded by
 * what a Sentinel gives one — never by a sleep, which would state a duration this host is
 * exactly the one not to be trusted about.
 */
export async function failedOver(sentinelUrl: string, client: PromotedClient): Promise<void> {
  const sentinel = await serverClient(sentinelUrl);
  const elapsed = stopwatch();
  let tilted = false;

  while (elapsed() < FAILOVER_BUDGET_MS) {
    const acting = await actingSentinel(sentinel, FAILOVER_BUDGET_MS - elapsed(), () => {
      tilted = true;
    });
    if (!acting) break;

    const promotion = promotionOf(client);
    const promoted = (await ask(sentinel)) && (await promotion.seen);
    promotion.giveUp();
    if (promoted) return;
  }

  if (tilted || (await tilting(sentinel))) throw new SentinelTiltError();

  throw new Error("the Sentinel published no promotion within the budget, and never tilted");
}

/**
 * Wait for a Sentinel that would act on a failover — out of TILT, with a replica it may
 * promote — within what is left of the budget, and say whether one was reached. A budget
 * that runs out is an answer here, not a throw: what it means depends on whether TILT was
 * what held it, which is the caller's to tell.
 */
async function actingSentinel(
  sentinel: ServerClient,
  budget: number,
  onTilt: () => void,
): Promise<boolean> {
  return vi
    .waitUntil(
      async () => {
        if (await tilting(sentinel)) {
          onTilt();

          return false;
        }

        return promotable(sentinel);
      },
      { interval: POLL_MS, timeout: Math.max(budget, POLL_MS) },
    )
    .then(() => true)
    .catch(() => false);
}

/**
 * Ask for the failover, reading every "not right now" the Sentinel has as "not yet" rather
 * than as a failure: `INPROG`, one is already pending, and `NOGOODSLAVE`, none is promotable
 * at this instant. The second is not the readiness condition being wrong — a failover selects
 * its replica with `sentinelSelectSlave`, whose conditions exceed the `master-link-status: ok`
 * this harness polls (the replica must also have answered a PING within the last five seconds
 * and not be `S_DOWN`), so on a loaded host the `SENTINEL REPLICAS` view and the selection
 * disagree for a beat. The Sentinel's answer is the truth, and the loop that re-checks and
 * asks again is already bounded, so nothing here waits on a delay. A replica that never
 * becomes promotable runs the budget out and is caught by the caller's throw.
 */
async function ask(sentinel: ServerClient): Promise<boolean> {
  const notYet = [FAILOVER_IN_PROGRESS, NO_PROMOTABLE_REPLICA];

  return sentinel
    .sendCommand(["SENTINEL", "FAILOVER", SENTINEL_MASTER_NAME])
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof Error && notYet.some((reply) => error.message.startsWith(reply)))
        return false;

      throw error;
    });
}

/**
 * The promotion of one attempt: whether the client was told within what a Sentinel gives an
 * attempt. The listener comes off either way, so that an attempt that was abandoned leaves
 * nothing behind for the next one to hear.
 */
function promotionOf(client: PromotedClient): { seen: Promise<boolean>; giveUp: () => void } {
  let stop = (): void => undefined;
  const seen = new Promise<boolean>((resolve) => {
    const told = (): void => {
      resolve(true);
    };
    const timer = setTimeout(() => {
      resolve(false);
    }, PROMOTION_MS);

    client.once("topology-change", told);
    stop = (): void => {
      clearTimeout(timer);
      client.off("topology-change", told);
      resolve(false);
    };
  });

  return {
    seen,
    giveUp: () => {
      stop();
    },
  };
}

/** Whether the Sentinel is in TILT, and so acting on nothing it decides. */
async function tilting(sentinel: ServerClient): Promise<boolean> {
  const info = await sentinel.sendCommand(["INFO", "sentinel"]);

  return !String(info).includes("sentinel_tilt:0");
}

/** Whether the Sentinel reports a replica whose link to the master is up. */
async function promotable(sentinel: ServerClient): Promise<boolean> {
  const replicas = (await sentinel.sendCommand([
    "SENTINEL",
    "REPLICAS",
    SENTINEL_MASTER_NAME,
  ])) as Record<string, string>[];

  return replicas.some((replica) => replica["master-link-status"] === "ok");
}

/** What a deployment showed of itself while a connection under it was rebuilt. */
export interface Disturbed {
  /** What the reader reads for the invalidated Entry once it has taken in the tag events. */
  entry: CacheEntry | undefined;
  /** The commands the Tag manifest and its log were carried by, over every node. */
  tagCommands: string[];
  /** How many rebuilt connections were counted while it happened. */
  rebuilds: number;
  /**
   * Every failure the client reported outside an operation while it happened: what an
   * operator sees of the disturbance through `onError(…, 'connect')`.
   */
  connectFailures: unknown[];
}

/**
 * Put two Instances of one app on either side of a disturbance, and hand back what the
 * deployment showed of it: whether the tag event one Instance wrote after it reached the
 * other, whether that Instance read the whole manifest to see it, and how many rebuilt
 * connections were counted on the way.
 *
 * The disturbance is the caller's — a killed connection, a failover — and so is the wait
 * for it to have happened: only the caller knows what its kind of client says when it has.
 * A caller that waits on what was reported rather than on an event takes the failures so
 * far from the accessor it is handed. Everything around it is the same narrative whichever
 * deployment is under it, which is what makes the answers comparable.
 */
export async function acrossADisturbance(
  { client, nodeUrls }: Topology,
  disturb: (failures: () => unknown[]) => Promise<void>,
): Promise<Disturbed> {
  const keyPrefix = freshPrefix();
  const failures: unknown[] = [];
  const handle = createCacheClient({ client }, (error) => failures.push(error));
  const reader = instanceOn(client, keyPrefix);
  const writer = instanceOn(client, keyPrefix);
  await storeBefore(writer, "posts", { tags: ["posts"] });
  await reader.refreshTags();
  const counted = handle.reconnects();
  const reported = failures.length;

  await disturb(() => failures.slice(reported));

  const settled = await tagCommandsOn(keyPrefix, nodeUrls);
  await vi.waitFor(() => writer.updateTags(["posts"]));
  await reader.refreshTags();
  const disturbed = {
    entry: await reader.get("posts", []),
    tagCommands: await settled(),
    rebuilds: handle.reconnects() - counted,
    connectFailures: failures.slice(reported),
  };
  await handle.close();

  return disturbed;
}

/** How long a killed node connection is given to be reported. */
const REPORTED_TIMEOUT_MS = 10_000;

/** How long the cell around it may take: that wait, and the two Instances on either side. */
const NODE_FAILURE_TIMEOUT_MS = 60_000;

/** The address of the node a reported failure names, as every kind that names one spells it. */
const NAMED_NODE = /\(.+:\d+\): /;

/**
 * What a client holding a connection per node owes the handler when one of them goes down:
 * the node's failure is reported as the `connect` failure a standalone deployment reports,
 * naming the node it happened on, and the deployment carries on propagating afterwards.
 *
 * It is one function rather than one copy per topology for the same reason `sharesTheStore`
 * is, and the disturbance is the one every deployment here is broken by — the connections of
 * every node killed — taken through `acrossADisturbance`, so that what it breaks is broken
 * the way the counting cells of each file break it.
 *
 * A Cluster client lets that failure out on `node-error` and is handed here as it is used. A
 * Sentinel client lets it out on nothing node-redis's `RedisSentinel` forwards — it keeps its
 * node clients' errors on an internal emitter and forwards only `error` and `topology-change`
 * — so the client handed here is one built with `passthroughClientErrorEvents`, the single
 * option under which a node's failure reaches a caller of that kind at all.
 */
export function reportsNodeFailures(topology: () => Topology): void {
  test(
    "the failure of a node connection is reported as a connect failure, and propagation survives it",
    async () => {
      const deployment = topology();

      const disturbed = await acrossADisturbance(deployment, async (failures) => {
        await onEveryNode(deployment.nodeUrls, KILL_CONNECTIONS);
        await vi.waitFor(() => expect(failures()).not.toHaveLength(0), REPORTED_TIMEOUT_MS);
      });

      const messages = disturbed.connectFailures.map((failure) =>
        failure instanceof Error ? failure.message : String(failure),
      );
      expect(disturbed.connectFailures.filter((failure) => failure instanceof Error)).toEqual(
        disturbed.connectFailures,
      );
      expect(messages.filter((message) => NAMED_NODE.test(message))).toEqual(messages);
      expect(disturbed.entry).toBeUndefined();
    },
    NODE_FAILURE_TIMEOUT_MS,
  );
}

/**
 * A client one test file created, listened to and connected: node-redis crashes the
 * process on a client that has no `error` listener, and a test file's client is the one
 * thing here the handler does not attach one to itself.
 */
export async function connected(client: TopologyClient): Promise<TopologyClient> {
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

/** The Entry this cell writes and reads back, and the key its node is asked for. */
const JUST_WRITTEN = "just-written";

/** How many times it reads that Entry: one chance in 256 of missing a replica read. */
const ENTRY_READS = 8;

/**
 * What a client the caller configured to read replicas owes the handler: nothing changes.
 * A replica-reading client — `replicaPoolSize` on a Sentinel, `useReplicas` on a Cluster —
 * is a choice a caller makes for their own traffic, and the handler's own reads are not
 * theirs to route: every one of them goes where the writes go.
 *
 * The cell states that as the node the Entry was read on, because that is the property and
 * because the outcome alone does not carry it: a replica of a deployment on one host is
 * handed the write within the microsecond, so a read routed to one comes back with the
 * Entry anyway and hides the routing. The `get` is asserted beside it as what a caller
 * sees of the same thing — a hit with no wait at all between the write and the read.
 *
 * It reads the Entry several times because one read decides nothing. A client that reads
 * replicas spreads a slot's reads over the master and its replicas, and node-redis picks
 * the first of them at random and then alternates: a single read of a handler that had
 * stopped routing its reads to the master would land on the master anyway on half the runs,
 * and a cell built on one would be a coin toss. `ENTRY_READS` reads leave that alternation
 * nowhere to hide. The count is not tuned to it, though — how a client spreads reads is its
 * own business and can change under this cell — so it is set where a client picking a node
 * at random per command, the worst spread this property survives, would still have to miss
 * the replica every time for the cell to go green. Every read is asserted a hit.
 */
export function readsTheMaster(topology: () => Topology): void {
  test("the Entry read runs on the master, whatever the client's replica reads", async () => {
    const keyPrefix = freshPrefix();
    const { client, nodeUrls } = topology();
    const master = await masterOf(entryKey(keyPrefix, JUST_WRITTEN), nodeUrls);
    const instance = instanceOn(client, keyPrefix);
    await instance.refreshTags();
    const settled = await entryReadsOn(keyPrefix, nodeUrls);

    await instance.set(JUST_WRITTEN, Promise.resolve(entryOf()));
    const entries = [];
    for (let read = 0; read < ENTRY_READS; read++)
      entries.push(await instance.get(JUST_WRITTEN, []));

    expect(await settled()).toEqual([master]);
    for (const entry of entries)
      expect(await bytesOf(entry?.value ?? new ReadableStream())).toEqual(VALUE);
  });
}
