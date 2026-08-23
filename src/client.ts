import { createClient, type RedisArgument, type TypeMapping } from "redis";

import type { CacheErrorHook } from "./events.js";
import type { CacheConnection } from "./options.js";

const CONNECT_TIMEOUT = 2_000;
const SOCKET_TIMEOUT = 15_000;
const PING_INTERVAL = 10_000;
const RECONNECT_CAP = 2_000;
const RECONNECT_JITTER = 200;

const NOT_CONNECTED = "the cache client is not connected";

/**
 * How long to wait before the next reconnection attempt: 50·2ⁿ ms, capped at 2 s, plus
 * up to 200 ms of jitter so that every Instance of a deployment does not come back on
 * the same millisecond.
 *
 * It is a delay for every attempt count, however large, and never `false` nor an
 * `Error`: node-redis reads either of those as "give up", which closes the client for
 * good and turns an outage into a handler that never works again. The doubling
 * overflows to `Infinity` long before that matters, and the cap takes it from there.
 */
export function reconnectDelay(retries: number): number {
  return Math.min(50 * 2 ** retries, RECONNECT_CAP) + Math.random() * RECONNECT_JITTER;
}

/**
 * The client every owned handle is built on, tuned for a store that may go away.
 *
 * `socketTimeout` is what bounds a handshake nothing answers: node-redis arms it on the
 * socket as soon as the TCP connect succeeds, so it covers the `HELLO` a proxy — or a
 * port forwarder in front of a dead server — accepts and never replies to, which
 * `connectTimeout` (the TCP connect alone) and the reconnect strategy both go through
 * without noticing. Until the socket is torn down, every operation spends its whole
 * deadline instead of failing at once, which is why 15 s is preferred to the 30 s a
 * default client waits.
 *
 * It cannot go much lower: it is an idle timeout, so it also fires on a healthy
 * connection nothing has sent anything on. `pingInterval` is what keeps such a connection
 * busy, one `PING` every 10 s re-armed once the reply is in, and 15 s is that floor plus
 * the round trip and the event-loop lag of a loaded host. Cutting the ping period to a
 * couple of seconds instead, which is what bringing the bound down to the order of
 * `connectTimeout` would take, would put a `PING` on that period on the store of every
 * Instance for as long as it runs, to shorten one rare failure.
 */
function createTunedClient(url: string) {
  return createClient({
    url,
    disableOfflineQueue: true,
    pingInterval: PING_INTERVAL,
    socket: {
      connectTimeout: CONNECT_TIMEOUT,
      socketTimeout: SOCKET_TIMEOUT,
      reconnectStrategy: reconnectDelay,
    },
  });
}

/**
 * The commands one operation runs on a standalone client, on a view with a chosen type
 * mapping: the raw command channel the Lua scripts go through, and the one typed command
 * the handler reads an Entry with.
 *
 * `hGetAll` is typed rather than sent as a raw command because a raw reply is not
 * normalised across RESP versions — a flat array on RESP2, a map on RESP3 — while a Lua
 * script's reply is, Redis converting it to RESP2 shapes unless the script asks for
 * otherwise, which none of these do.
 */
export interface CacheCommands {
  /** Send one command, argument by argument, exactly as given. */
  sendCommand(args: readonly RedisArgument[]): Promise<unknown>;
  /**
   * Every field of one hash. The values are `unknown` because the view's type mapping
   * decides what they are at runtime and that mapping is not carried in this type: the
   * one caller of it asks for bytes and narrows the fields itself.
   */
  hGetAll(key: RedisArgument): Promise<Record<string, unknown>>;
}

/**
 * The same commands on a Sentinel client, which takes the read/write intent of a command
 * before its arguments: it is what decides whether the command goes to the master or to a
 * replica. The handler always asks for the master.
 */
export interface SentinelCacheCommands {
  /** Send one command, told whether it may run on a replica. */
  sendCommand(isReadonly: boolean, args: readonly RedisArgument[]): Promise<unknown>;
  /** Every field of one hash, on the node the client routes it to. */
  hGetAll(key: RedisArgument): Promise<Record<string, unknown>>;
}

/**
 * The same commands on a Cluster client, which takes the key that routes the command
 * before its intent: the slot of that key is the node the command is sent to. Every
 * script this library runs states its routing key as `KEYS[1]`.
 */
export interface ClusterCacheCommands {
  /** Send one command, routed by the given key, told whether it may run on a replica. */
  sendCommand(
    firstKey: RedisArgument,
    isReadonly: boolean,
    args: readonly RedisArgument[],
  ): Promise<unknown>;
  /** Every field of one hash, on the node the key's slot belongs to. */
  hGetAll(key: RedisArgument): Promise<Record<string, unknown>>;
}

/**
 * What the handler listens to on its client, over the three kinds: a failure of the client
 * itself, the failure of a node under it — which only the kinds that hold node connections
 * name — and a connection being rebuilt, which each kind names differently and one of them
 * does not name at all. `clientKind` decides which of these one client is subscribed to.
 */
export type CacheClientEvent =
  "error" | "reconnecting" | "node-reconnecting" | "node-error" | "topology-change";

/**
 * A client of one kind: what the handler uses of a node-redis client, and nothing more.
 *
 * It is this narrow structurally, rather than node-redis's `RedisClientType`, so that a
 * client the caller injected satisfies it whatever its generic parameters. A client
 * created with custom scripts, or with `RESP: 2`, is not assignable to `RedisClientType`
 * at all, and this library has no reason to know about either. The events are one union
 * for every kind because all three clients are plain event emitters: subscribing is what
 * differs, not what may be named.
 */
export interface CacheClientOf<Commands> {
  /** This client, seen through the given type mapping. */
  withTypeMapping(typeMapping: TypeMapping): Commands;
  /**
   * Listen to the client's failures, inside an operation and outside any, and to its
   * connection being rebuilt. A listener takes as many arguments as the event carries:
   * one for most of them, two for the `node-error` a Cluster client emits with the node's
   * error and the node's address.
   */
  on(event: CacheClientEvent, listener: (...payload: unknown[]) => void): unknown;
  /** Stop listening: what `close()` undoes of what the handler attached. */
  off(event: CacheClientEvent, listener: (...payload: unknown[]) => void): unknown;
}

/**
 * The client every operation of one handler object runs on: a standalone node-redis
 * client, a Sentinel client, or a Cluster client. The three differ in exactly one member
 * the handler uses — the arguments `sendCommand` takes — and `runScript` is the only
 * place that difference is spelled out.
 */
export type CacheClient =
  | CacheClientOf<CacheCommands>
  | CacheClientOf<SentinelCacheCommands>
  | CacheClientOf<ClusterCacheCommands>;

/** Which of the three node-redis clients one injected client is. */
export type CacheClientKind = "standalone" | "sentinel" | "cluster";

const NODE_CLIENT = "nodeClient";

const EXECUTE = "_execute";

/**
 * Which kind a client is: the one structural check of this library, whose answer decides
 * how `runScript` calls `sendCommand` and which event a rebuilt connection is counted on.
 *
 * It is structural rather than an `instanceof`, because a caller's client may come from
 * another copy of node-redis, and it reads a member rather than an arity, because the
 * number of parameters a function declares is not a contract anyone maintains. A Cluster
 * client is the one that routes by node, so it is the one that owns `nodeClient`; of the
 * two left, a Sentinel client is the one that executes through a node it leases, which is
 * `_execute` — the leased `RedisSentinelClient` has that but not the `use` of the
 * `RedisSentinel` it came from, so `use` would read a leased client as standalone and send
 * it a command list where it expects a read/write intent. A standalone client has neither.
 *
 * The order is what makes `_execute` sound: a Cluster client has one too, and has already
 * been answered for by the time it is read.
 */
export function clientKind(client: CacheClient): CacheClientKind {
  if (NODE_CLIENT in client) return "cluster";
  if (EXECUTE in client) return "sentinel";

  return "standalone";
}

/**
 * The event each kind emits when a connection under it is rebuilt.
 *
 * A standalone client says `reconnecting` for itself, and a Cluster client says
 * `node-reconnecting` for the node whose socket is coming back. A Sentinel client says
 * nothing of the sort: it rebuilds its node clients out of sight, and node-redis's
 * `RedisSentinel` forwards only two events off the emitter that would know — `error` and
 * `topology-change` — so a change of topology, a failover among them, is the one thing a
 * rebuilt connection can be counted on there.
 *
 * Counting more often than a connection is really rebuilt costs one full read of the Tag
 * manifest and nothing else, which is why an event as broad as a topology change is taken
 * as one.
 */
const RECONNECT_EVENTS: Record<CacheClientKind, readonly CacheClientEvent[]> = {
  standalone: ["reconnecting"],
  sentinel: ["topology-change"],
  cluster: ["node-reconnecting"],
};

/**
 * The event each kind lets the failure of a node under it out as, reported through the same
 * `connect` as the client's own `error`, so that an outage of a node means the same thing
 * wherever a deployment holds one.
 *
 * A standalone client has none: it holds one connection, and its `error` is that failure.
 * A Cluster client emits `node-error`, the node's error first and the node's address second,
 * which is read here into an `Error` naming that node. A Sentinel client has none a caller
 * can hear: node-redis's `RedisSentinel` keeps the failures of its node connections on an
 * internal emitter and forwards only `error` and `topology-change` off it, so the one
 * channel a node failure reaches is the `error` a client built with
 * `passthroughClientErrorEvents` re-emits, already wrapped by node-redis with the node it
 * happened on, and the handler's `error` listener carries it.
 */
const NODE_FAILURES: Record<CacheClientKind, readonly NodeFailure[]> = {
  standalone: [],
  sentinel: [],
  cluster: [{ event: "node-error", errorOf: clusterNodeError }],
};

/** What one kind lets the failure of a node under it out as, and how that payload is read. */
interface NodeFailure {
  /** The event that failure is emitted on. */
  event: CacheClientEvent;
  /** The `Error` the handler reports for one emission of it, whatever its payload holds. */
  errorOf: (payload: readonly unknown[]) => Error;
}

/**
 * The `Error` a Cluster client's `node-error` reaches `onError` as: the node it happened on,
 * as node-redis emits it after the node's own error, and that error as the `cause`.
 *
 * It is an `Error` whatever the payload holds — a caller's client may come from another copy
 * of node-redis, and a hook handed a bare object instead of an error has nothing to log — so
 * a payload that reads as neither loses the address and is stringified for its message.
 */
function clusterNodeError(payload: readonly unknown[]): Error {
  const [cause, node] = payload;
  const { host, port } = (node ?? {}) as { host?: unknown; port?: unknown };
  const where = host === undefined ? "" : ` (${String(host)}:${String(port)})`;
  const message = cause instanceof Error ? cause.message : String(cause);

  return new Error(`Cluster node${where}: ${message}`, { cause });
}

/**
 * The client of one handler object, whoever owns it: the same two calls whether the
 * handler created it from a URL or the caller injected it.
 */
export interface CacheClientHandle {
  /**
   * The client to run an operation on, connecting it on the first call when the handler
   * owns it. An injected client is returned as it is, connected or not: connecting a
   * client the caller owns would change a lifecycle that is theirs.
   */
  connected(): Promise<CacheClient>;
  /**
   * How many times the client has begun reconnecting since the handler attached to it.
   * A read of the Tag manifest compares it against the count of its last read: any
   * change means events may have been written while the connection was down, and the
   * whole manifest has to be read again.
   */
  reconnects(): number;
  /**
   * Quit a client the handler owns, or resolve immediately when it was never used. A
   * connection attempt still in progress is destroyed rather than awaited: the reconnect
   * strategy never gives up, so a shutdown during an outage would otherwise never return.
   * An injected client is left open, and only the handler's own listeners are taken off
   * it.
   */
  close(): Promise<void>;
}

/**
 * Build the client one handler object owns.
 *
 * Nothing is connected here: the handler module is loaded in every `next build`
 * worker and in the dev server as well as in `next start`, and a process that never
 * reads or writes an Entry must never open a socket. The tuning is fixed: the default
 * reconnect strategy gives up for good on a socket timeout, and node-redis crashes the
 * process when a client has no `error` listener.
 *
 * That mandatory listener is where `fail` is called with `connect`: node-redis emits
 * `error` for socket failures and for every failed connection attempt, outside any
 * operation of the handler, and a Cluster client says the same of a node under it on an
 * event of its own. `fail` is the reporter's, which never throws, so nothing
 * of a caller's can propagate back into node-redis's emitter.
 */
export function createCacheClient(
  connection: CacheConnection,
  fail: CacheErrorHook,
): CacheClientHandle {
  const report = (error: unknown): void => {
    fail(error, "connect");
  };

  return "url" in connection
    ? ownedClient(connection.url, report)
    : injectedClient(connection.client, report);
}

/**
 * Attach what the handler listens to, on a client of any of the three kinds: the `error`
 * listener node-redis crashes the process without, the node-level failure a kind that holds
 * node connections lets out beside it, and the count of reconnections a refresh of the
 * Tag manifest reads, on whichever events that kind names one by. `detach`
 * takes back exactly the listeners it attached, so that one long-lived injected client
 * feeding many handler objects collects none of them. It is for an injected client only:
 * a client the handler owns keeps its `error` listener to the end, since a socket error
 * surfacing after `close()` on a client that has none crashes the process.
 */
function listenTo(client: CacheClient, report: (error: unknown) => void) {
  let reconnects = 0;
  const count = (): void => {
    reconnects += 1;
  };
  const kind = clientKind(client);
  const listeners: [CacheClientEvent, (...payload: unknown[]) => void][] = [
    ["error", report],
    ...RECONNECT_EVENTS[kind].map((event): [CacheClientEvent, () => void] => [event, count]),
    ...NODE_FAILURES[kind].map(
      ({ event, errorOf }): [CacheClientEvent, (...payload: unknown[]) => void] => [
        event,
        (...payload) => {
          report(errorOf(payload));
        },
      ],
    ),
  ];

  for (const [event, listener] of listeners) client.on(event, listener);

  return {
    reconnects: (): number => reconnects,
    detach: (): void => {
      for (const [event, listener] of listeners) client.off(event, listener);
    },
  };
}

/**
 * The handler's own client: created here, connected on first use and quit on `close()`.
 *
 * The first operation is the one that waits for the connection; every later one, while
 * the client is not ready and has already been seen failing, is handed the failure at
 * once instead of waiting out its deadline. A connection attempt against a server that
 * is down never settles at all — the reconnect strategy never gives up — so waiting on it
 * would spend the whole deadline of every operation for as long as the outage lasts.
 *
 * Nothing is latched: the client keeps reconnecting on its own, and the moment it is ready
 * again it is handed over as before, which is how one handler object comes back from an
 * outage without being rebuilt.
 */
function ownedClient(url: string, report: (error: unknown) => void): CacheClientHandle {
  const client = createTunedClient(url);
  const listeners = listenTo(client, report);

  let connecting: Promise<CacheClient> | undefined;
  let failed = false;
  client.on("error", () => {
    failed = !client.isReady;
  });

  return {
    reconnects: listeners.reconnects,
    connected(): Promise<CacheClient> {
      if (client.isReady) return Promise.resolve(client);
      if (connecting !== undefined && failed) return Promise.reject(new Error(NOT_CONNECTED));

      connecting ??= client.connect().then(
        () => {
          client.unref();
          return client;
        },
        (error: unknown) => {
          connecting = undefined;
          throw error;
        },
      );

      return connecting;
    },
    async close(): Promise<void> {
      const attempt = connecting;
      if (attempt === undefined) return;
      connecting = undefined;

      if (client.isReady) {
        await client.close();
      } else {
        client.destroy();
      }

      await attempt.catch(() => undefined);
    },
  };
}

/**
 * A client the caller owns: used exactly as it was handed over. The handler's own listeners
 * are the one thing it adds, so that a connection failure of an injected client — its own, or
 * that of a node under it — is reported like any other and a reconnection of it is counted,
 * and `close()` takes them back off: one long-lived client feeding many handler objects must
 * not collect a listener per handler.
 */
function injectedClient(client: CacheClient, report: (error: unknown) => void): CacheClientHandle {
  const listeners = listenTo(client, report);

  return {
    reconnects: listeners.reconnects,
    connected(): Promise<CacheClient> {
      return Promise.resolve(client);
    },
    close(): Promise<void> {
      listeners.detach();

      return Promise.resolve();
    },
  };
}
