import { createDisabledHandler } from "./disabled-handler.js";
import { optionsFromEnv } from "./env.js";
import { createRedisCacheHandler } from "./redis-cache-handler.js";
import type { CacheHandler } from "./types.js";

/**
 * The Zero-config entry: one plain handler object, configured from the environment when
 * this module is loaded.
 *
 * It is an object rather than a class or a factory because Next.js loads the module with
 * a native `import()` and unwraps `default` twice, so the exported object must not itself
 * carry a `default` property. An app registers it by path — `cacheHandlers: { default:
 * handlerPath }`, or `require.resolve('@flefebvre/nextjs-redis-cache-handler/handler')` —
 * and configures it with environment variables only:
 *
 * - `REDIS_URL` → `url`
 * - `NEXT_REDIS_CACHE_KEY_PREFIX` → `keyPrefix`
 * - `NEXT_REDIS_CACHE_MAX_TTL` → `maxTtl`, in seconds
 * - `NEXT_REDIS_CACHE_MAX_ENTRY_SIZE` → `maxEntrySize`, in bytes
 * - `NEXT_REDIS_CACHE_OPERATION_TIMEOUT` → `operationTimeout`, in milliseconds
 * - `NEXT_REDIS_CACHE_UPDATE_TAGS_TIMEOUT` → `updateTagsTimeout`, in milliseconds
 * - `NEXT_REDIS_CACHE_DEBUG` → `debug`, one of `1`, `true`, `0` and `false`
 *
 * A variable that is unset or empty leaves its option at the factory's default. An app
 * that needs an option no variable covers — `client`, `onEvent`, `onError` — calls
 * `createRedisCacheHandler` itself instead and points `cacheHandlers` at its own module.
 *
 * A value nobody can use is a throw right here, at module load, where the configuration
 * is: a value that is no whole number, or no boolean, names the variable, and a value the
 * factory refuses names the option it maps to — `NEXT_REDIS_CACHE_MAX_TTL=0` throws
 * ``` `maxTtl` must be a positive integer ```. No `REDIS_URL` at all is the one
 * misconfiguration that does not throw: a build box with no store then gets a handler
 * that caches nothing and says so once, rather than a build that fails over a cache it
 * never needed.
 *
 * Loading this module opens no connection, in `next build`, `next dev` and `next start`
 * alike: the client is dialled by the first operation that needs it.
 */
const handler: CacheHandler = fromEnvironment();

function fromEnvironment(): CacheHandler {
  const options = optionsFromEnv(process.env);

  return options === undefined ? createDisabledHandler() : createRedisCacheHandler(options);
}

export default handler;
