import handler from "@flefebvre/nextjs-redis-cache-handler/handler";
import {
  createRedisCacheHandler,
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

export function consume(): void {
  const configured: CacheHandler & { close(): Promise<void> } = createRedisCacheHandler(options);

  void path;
  void zeroConfig;
  void writtenAt;
  void configured;
}
