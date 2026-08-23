import handler from "@flefebvre/nextjs-redis-cache-handler/handler";
import { createClient, createCluster, createSentinel } from "redis";
import {
  createRedisCacheHandler,
  optionsFromEnv,
  type CacheClient,
  type CacheCommands,
  type ClusterCacheCommands,
  type SentinelCacheCommands,
  handlerPath,
  type CacheEntry,
  type CacheErrorHook,
  type CacheErrorOp,
  type CacheEvent,
  type CacheEventHook,
  type CacheHandler,
  type CacheMissReason,
  type CacheSkipReason,
  type RedisCacheHandlerOptions,
  type Timestamp,
} from "@flefebvre/nextjs-redis-cache-handler";

const path: string = handlerPath;

const zeroConfig: CacheHandler = handler;

declare const entry: CacheEntry;
const writtenAt: Timestamp = entry.timestamp;

const onEvent: CacheEventHook = (event: CacheEvent): void => {
  if (event.type === "miss") {
    const reason: CacheMissReason = event.reason;
    void reason;
  } else if (event.type === "skip") {
    const reason: CacheSkipReason = event.reason;
    const size: number = event.size;
    void reason;
    void size;
  }

  const key: string = event.key;
  const durationMs: number = event.durationMs;
  void key;
  void durationMs;
};

const onError: CacheErrorHook = (error: unknown, op: CacheErrorOp): void => {
  void error;
  void op;
};

const options: RedisCacheHandlerOptions = {
  url: "redis://localhost:6379",
  maxEntrySize: 1024,
  debug: true,
  onEvent,
  onError,
};

const injected: CacheClient = createClient({ url: "redis://localhost:6379" });

const clustered: CacheClient = createCluster({ rootNodes: [{ url: "redis://localhost:7000" }] });

const standaloneCommands: CacheCommands = injected.withTypeMapping({});
const clusterCommands: ClusterCacheCommands = clustered.withTypeMapping({});

const watched: CacheClient = createSentinel({
  name: "mymaster",
  sentinelRootNodes: [{ host: "localhost", port: 26379 }],
});

const sentinelCommands: SentinelCacheCommands = watched.withTypeMapping({});

const fromEnvironment: RedisCacheHandlerOptions | undefined = optionsFromEnv(process.env);

const withInjectedClient: RedisCacheHandlerOptions = {
  client: injected,
  keyPrefix: "app:",
  operationTimeout: 500,
  updateTagsTimeout: 5000,
};

const withClusterClient: RedisCacheHandlerOptions = { client: clustered, keyPrefix: "app:" };

const withSentinelClient: RedisCacheHandlerOptions = { client: watched, keyPrefix: "app:" };

export function consume(): void {
  const configured: CacheHandler & { close(): Promise<void> } = createRedisCacheHandler(options);
  const injecting: CacheHandler & { close(): Promise<void> } =
    createRedisCacheHandler(withInjectedClient);

  const clustering: CacheHandler & { close(): Promise<void> } =
    createRedisCacheHandler(withClusterClient);
  const watching: CacheHandler & { close(): Promise<void> } =
    createRedisCacheHandler(withSentinelClient);

  void injecting;
  void standaloneCommands;
  void clusterCommands;
  void sentinelCommands;
  void clustering;
  void watching;

  void fromEnvironment;
  void path;
  void zeroConfig;
  void writtenAt;
  void configured;
}
