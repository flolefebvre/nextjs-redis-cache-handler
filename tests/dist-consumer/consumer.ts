import handler from "@flefebvre/nextjs-redis-cache-handler/handler";
import {
  createRedisCacheHandler,
  handlerPath,
  type CacheEntry,
  type CacheHandler,
  type Timestamp,
} from "@flefebvre/nextjs-redis-cache-handler";

const path: string = handlerPath;

const zeroConfig: CacheHandler = handler;

declare const entry: CacheEntry;
const writtenAt: Timestamp = entry.timestamp;

export function consume(): void {
  const configured: CacheHandler & { close(): Promise<void> } = createRedisCacheHandler();

  void path;
  void zeroConfig;
  void writtenAt;
  void configured;
}
