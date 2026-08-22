import { fileURLToPath } from "node:url";

export type * from "./public-types.js";
export { createRedisCacheHandler } from "./redis-cache-handler.js";
export { optionsFromEnv } from "./env.js";

/**
 * Absolute filesystem path of the Zero-config entry, resolved when this module is
 * imported. `cacheHandlers` in `next.config` takes a path, not a module, so an app
 * that configures the handler in code hands Next.js this value.
 */
export const handlerPath: string = fileURLToPath(new URL("./handler.js", import.meta.url));
