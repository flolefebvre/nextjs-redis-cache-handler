import { LOG_PREFIX } from "./events.js";
import type { CacheEntry, CacheHandler, Timestamp } from "./types.js";

const DISABLED =
  `${LOG_PREFIX} REDIS_URL is not set: the cache is disabled. Every read is a miss and ` +
  `every write is dropped, so nothing is shared between Instances.`;

/**
 * The handler the Zero-config entry falls back to when no store is configured: it stores
 * nothing and serves nothing, and no operation ever fails.
 *
 * A build box with no Redis is the case this exists for. Throwing at module load would
 * fail a build that never needed the cache, and dialling a store that is not there would
 * make every request wait for a connection that cannot happen, so the handler answers
 * like an empty cache instead: `get` a miss, `set` dropped once the Entry it was handed
 * has been drained, `updateTags` and `refreshTags` nothing to do, and `getExpiration`
 * `Infinity`, which is what the Redis-backed handler answers too.
 *
 * Silence would be worse than the outage it stands for, so the first operation — whichever
 * one it is — reports once, and only once, however long the process then runs: an app that
 * lost its `REDIS_URL` says so, without one line per cache read. `report` defaults to
 * `console.error`; the tests hand over their own.
 */
export function createDisabledHandler(
  report: (message: string) => void = logDisabled,
): CacheHandler {
  let reported = false;
  const reportOnce = (): void => {
    if (reported) return;
    reported = true;
    report(DISABLED);
  };

  return {
    get(): Promise<undefined | CacheEntry> {
      reportOnce();

      return Promise.resolve(undefined);
    },
    async set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void> {
      reportOnce();

      await pendingEntry.catch(() => undefined);
    },
    refreshTags(): Promise<void> {
      reportOnce();

      return Promise.resolve();
    },
    getExpiration(): Promise<Timestamp> {
      reportOnce();

      return Promise.resolve(Infinity);
    },
    updateTags(): Promise<void> {
      reportOnce();

      return Promise.resolve();
    },
  };
}

function logDisabled(message: string): void {
  console.error(message);
}
