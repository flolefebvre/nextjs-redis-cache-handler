import type { CacheEntry, CacheHandler, Timestamp } from "./types.js";

/**
 * The Zero-config entry: one plain handler object, configured from the environment.
 *
 * It is an object rather than a class or a factory because Next.js loads the module
 * with a native `import()` and unwraps `default` twice, so the exported object must
 * not itself carry a `default` property.
 *
 * Not implemented yet: every method throws.
 */
const handler: CacheHandler = {
  get(): Promise<undefined | CacheEntry> {
    throw new Error("the zero-config handler is not implemented yet");
  },
  set(): Promise<void> {
    throw new Error("the zero-config handler is not implemented yet");
  },
  refreshTags(): Promise<void> {
    throw new Error("the zero-config handler is not implemented yet");
  },
  getExpiration(): Promise<Timestamp> {
    throw new Error("the zero-config handler is not implemented yet");
  },
  updateTags(): Promise<void> {
    throw new Error("the zero-config handler is not implemented yet");
  },
};

export default handler;
