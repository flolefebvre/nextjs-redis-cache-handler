import { createClient, type RedisArgument, type TypeMapping } from "redis";

import type { CacheErrorHook } from "./events.js";
import type { CacheConnection } from "./options.js";

const CONNECT_TIMEOUT = 2_000;
const SOCKET_TIMEOUT = 30_000;
const PING_INTERVAL = 10_000;
const RECONNECT_CAP = 2_000;
const RECONNECT_JITTER = 200;

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
 * The commands one operation runs, on a client view with a chosen type mapping: the raw
 * command channel the Lua scripts go through, and the one typed command the handler
 * reads an Entry with.
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
 * The client every operation of one handler object runs on: what the handler uses of a
 * node-redis client, and nothing more.
 *
 * It is this narrow structurally, rather than node-redis's `RedisClientType`, so that a
 * client the caller injected satisfies it whatever its generic parameters. A client
 * created with custom scripts, or with `RESP: 2`, is not assignable to `RedisClientType`
 * at all, and this library has no reason to know about either.
 */
export interface CacheClient {
  /** This client, seen through the given type mapping. */
  withTypeMapping(typeMapping: TypeMapping): CacheCommands;
  /** Listen to the client's failures, inside an operation and outside any. */
  on(event: "error", listener: (error: unknown) => void): unknown;
  /** Stop listening: what `close()` undoes of what the handler attached. */
  off(event: "error", listener: (error: unknown) => void): unknown;
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
   * Quit a client the handler owns, or resolve immediately when it was never used. A
   * connection attempt still in progress is destroyed rather than awaited: the reconnect
   * strategy never gives up, so a shutdown during an outage would otherwise never return.
   * An injected client is left open, and only the handler's own `error` listener is
   * taken off it.
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
 * operation of the handler. `fail` is the reporter's, which never throws, so nothing of
 * a caller's can propagate back into node-redis's emitter.
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
 * The handler's own client: created here, connected on first use and quit on `close()`.
 */
function ownedClient(url: string, report: (error: unknown) => void): CacheClientHandle {
  const client = createTunedClient(url);
  client.on("error", report);

  let connecting: Promise<CacheClient> | undefined;

  return {
    connected(): Promise<CacheClient> {
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
 * A client the caller owns: used exactly as it was handed over. The `error` listener is
 * the one thing the handler adds, so that a connection failure of an injected client is
 * reported like any other, and `close()` takes that listener back off: one long-lived
 * client feeding many handler objects must not collect a listener per handler.
 */
function injectedClient(client: CacheClient, report: (error: unknown) => void): CacheClientHandle {
  client.on("error", report);

  return {
    connected(): Promise<CacheClient> {
      return Promise.resolve(client);
    },
    close(): Promise<void> {
      client.off("error", report);

      return Promise.resolve();
    },
  };
}
