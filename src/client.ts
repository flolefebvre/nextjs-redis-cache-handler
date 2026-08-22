import { createClient, type RedisArgument, type TypeMapping } from "redis";

import type { CacheErrorHook } from "./events.js";

const CONNECT_TIMEOUT = 2_000;
const SOCKET_TIMEOUT = 30_000;
const PING_INTERVAL = 10_000;
const RECONNECT_CAP = 2_000;
const RECONNECT_JITTER = 200;

function createTunedClient(url: string) {
  return createClient({
    url,
    disableOfflineQueue: true,
    pingInterval: PING_INTERVAL,
    socket: {
      connectTimeout: CONNECT_TIMEOUT,
      socketTimeout: SOCKET_TIMEOUT,
      reconnectStrategy: (retries: number) =>
        Math.min(50 * 2 ** retries, RECONNECT_CAP) + Math.random() * RECONNECT_JITTER,
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
   * Every field of one hash. The values are `unknown` because this view's type mapping
   * decides what they are at runtime and the mapping is not carried in this type: the
   * one caller passes bytes and reads bytes back.
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
}

/** A client the handler owns: connected on first use, quit on `close()`. */
export interface CacheClientHandle {
  /** The client, connecting it on the first call and reusing it afterwards. */
  connected(): Promise<CacheClient>;
  /**
   * Quit the client, or resolve immediately when it was never used. A connection
   * attempt still in progress is destroyed rather than awaited: the reconnect strategy
   * never gives up, so a shutdown during an outage would otherwise never return.
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
export function createCacheClient(url: string, fail: CacheErrorHook): CacheClientHandle {
  const client = createTunedClient(url);
  client.on("error", (error: unknown) => fail(error, "connect"));

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
