import { fileURLToPath } from "node:url";

import type { CacheHandler } from "./types.js";

export type { CacheEntry, CacheHandler, Timestamp } from "./types.js";

/**
 * Absolute filesystem path of the Zero-config entry, resolved when this module is
 * imported. `cacheHandlers` in `next.config` takes a path, not a module, so an app
 * that configures the handler in code hands Next.js this value.
 */
export const handlerPath: string = fileURLToPath(new URL("./handler.js", import.meta.url));

/**
 * Build a Cache Handler backed by Redis or Valkey.
 *
 * Not implemented yet: the scaffold ships the entry so the `exports` map and the
 * package's public shape exist from day one.
 */
export function createRedisCacheHandler(): CacheHandler & { close(): Promise<void> } {
  throw new Error("createRedisCacheHandler is not implemented yet");
}
