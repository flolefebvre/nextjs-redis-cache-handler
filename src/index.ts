import { fileURLToPath } from "node:url";

export type { CacheEntry, CacheHandler, Timestamp } from "./types.js";
export type { RedisCacheHandlerOptions } from "./options.js";
export type { CacheClient, CacheClientEvent, CacheCommands } from "./client.js";
export type {
  CacheErrorHook,
  CacheErrorOp,
  CacheEvent,
  CacheEventHook,
  CacheMissReason,
  CacheSkipReason,
} from "./events.js";
export { createRedisCacheHandler } from "./redis-cache-handler.js";
export { optionsFromEnv } from "./env.js";

/**
 * Absolute filesystem path of the Zero-config entry, resolved when this module is
 * imported. `cacheHandlers` in `next.config` takes a path, not a module, so an app
 * that configures the handler in code hands Next.js this value.
 */
export const handlerPath: string = fileURLToPath(new URL("./handler.js", import.meta.url));
