import { createClient } from "redis";

import { writeEntryScript } from "./scripts.js";

const CONNECT_TIMEOUT = 2_000;
const SOCKET_TIMEOUT = 30_000;
const PING_INTERVAL = 10_000;
const RECONNECT_CAP = 2_000;
const RECONNECT_JITTER = 200;

function createTunedClient(url: string) {
  return createClient({
    url,
    scripts: { writeEntryHash: writeEntryScript },
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

/** The connected client every operation of one handler object runs on. */
export type CacheClient = ReturnType<typeof createTunedClient>;

/** A client the handler owns: connected on first use, quit on `close()`. */
export interface CacheClientHandle {
  /** The client, connecting it on the first call and reusing it afterwards. */
  connected(): Promise<CacheClient>;
  /** Quit the client, or resolve immediately when it was never used. */
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
 */
export function createCacheClient(url: string): CacheClientHandle {
  const client = createTunedClient(url);
  client.on("error", () => undefined);

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
      if (connecting === undefined) return;

      await connecting.catch(() => undefined);
      await client.close();
    },
  };
}
