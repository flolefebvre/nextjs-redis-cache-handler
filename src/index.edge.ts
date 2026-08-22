import { createDisabledHandler, EDGE_UNSUPPORTED } from "./disabled-handler.js";
import type { RedisCacheHandlerOptions } from "./options.js";
import type { CacheHandler } from "./types.js";

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
export { optionsFromEnv } from "./env.js";

/**
 * The Edge target of the factory: it takes the same options, ignores them, and hands back
 * the disabled handler.
 *
 * An app that needs an option no environment variable covers writes its own handler module
 * and calls this factory there. Next.js bundles that module into the Edge compilation of
 * every Edge-bundled route, specifier and all, so the real factory — and through it
 * `redis`, `node:net`, `node:tls`, `node:crypto` — would fail the build. Under the
 * `edge-light` condition the specifier lands here instead: the app builds, and the
 * `'use cache'` scopes of its Edge routes render uncached and say so once.
 */
export function createRedisCacheHandler(
  options: RedisCacheHandlerOptions,
): CacheHandler & { close(): Promise<void> } {
  void options;

  return { ...createDisabledHandler(EDGE_UNSUPPORTED), close: () => Promise.resolve() };
}

/**
 * The empty string, on the Edge runtime: nothing there can load the Zero-config entry, and
 * `next.config` — the one place this value is read — never runs on Edge.
 *
 * The Node.js target derives the real path with `fileURLToPath`, which no Edge bundle can
 * resolve (`node:url` is an unhandled scheme for webpack, an unsupported external for
 * Turbopack). Deriving it from `import.meta.url` instead is worse than useless and must not
 * be tried again: webpack yields a `blob:` URL, and Turbopack emits `dist/handler.js` as a
 * client static asset, dragging the Node.js target — and its `redis` import — into the
 * client output.
 */
export const handlerPath: string = "";
