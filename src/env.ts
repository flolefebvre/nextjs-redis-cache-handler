import type { RedisCacheHandlerOptions } from "./options.js";

const BOOLEANS = new Map([
  ["1", true],
  ["true", true],
  ["0", false],
  ["false", false],
]);

/**
 * Read one environment into the options the factory takes, or `undefined` when the store
 * to use is not configured at all.
 *
 * This is the whole variable table of the package, and the only place it lives:
 *
 * - `REDIS_URL` → `url`
 * - `NEXT_REDIS_CACHE_KEY_PREFIX` → `keyPrefix`, verbatim
 * - `NEXT_REDIS_CACHE_MAX_TTL` → `maxTtl`, in seconds
 * - `NEXT_REDIS_CACHE_MAX_ENTRY_SIZE` → `maxEntrySize`, in bytes
 * - `NEXT_REDIS_CACHE_OPERATION_TIMEOUT` → `operationTimeout`, in milliseconds
 * - `NEXT_REDIS_CACHE_UPDATE_TAGS_TIMEOUT` → `updateTagsTimeout`, in milliseconds
 * - `NEXT_REDIS_CACHE_DEBUG` → `debug`, one of `1`, `true`, `0` and `false`
 *
 * A variable that is unset or empty is not given, and the option keeps its default: a
 * deployment tool that materialises an unset variable as `""` configures nothing by
 * accident. `REDIS_URL` unset or empty is what `undefined` reports, so that the caller
 * cannot mistake "no store" for "default store".
 *
 * The environment is a table of strings, so a value that is no whole number, or no
 * boolean, is rejected here — naming the variable, since that is what its author can act
 * on. Nothing else is checked: a value this function could parse is handed to the factory
 * as it is, and `resolveOptions` is still the one place that says what an option accepts.
 * A `NEXT_REDIS_CACHE_MAX_TTL` of `0` therefore throws from the factory, naming `maxTtl`.
 *
 * Every variable is parsed before the URL is looked at, so an unusable value is reported
 * on a host that has no `REDIS_URL` too, rather than lying dormant until the day one is
 * set.
 *
 * The Zero-config entry is the first caller, and an app is the other: no variable covers
 * `onEvent`, `onError` or `client`, so an app that wants the environment's configuration
 * plus hooks of its own spreads this over them —
 * `createRedisCacheHandler({ ...optionsFromEnv(process.env), onEvent })` — and points
 * `cacheHandlers` at its own module. Such a caller owns the `undefined` case: it means
 * this environment configures no store, and it is for the app to decide whether that is a
 * handler that caches nothing, as the Zero-config entry does, or a startup failure.
 */
export function optionsFromEnv(env: NodeJS.ProcessEnv): RedisCacheHandlerOptions | undefined {
  const options = {
    keyPrefix: given(env, "NEXT_REDIS_CACHE_KEY_PREFIX"),
    operationTimeout: integer(env, "NEXT_REDIS_CACHE_OPERATION_TIMEOUT"),
    updateTagsTimeout: integer(env, "NEXT_REDIS_CACHE_UPDATE_TAGS_TIMEOUT"),
    maxTtl: integer(env, "NEXT_REDIS_CACHE_MAX_TTL"),
    maxEntrySize: integer(env, "NEXT_REDIS_CACHE_MAX_ENTRY_SIZE"),
    debug: boolean(env, "NEXT_REDIS_CACHE_DEBUG"),
  };
  const url = given(env, "REDIS_URL");

  return url === undefined ? undefined : { url, ...options };
}

function given(env: NodeJS.ProcessEnv, variable: string): string | undefined {
  const value = env[variable];

  return value === undefined || value === "" ? undefined : value;
}

function integer(env: NodeJS.ProcessEnv, variable: string): number | undefined {
  const value = given(env, variable);
  if (value === undefined) return undefined;

  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`\`${variable}\` must be a whole number, was \`${value}\``);
  }

  return parsed;
}

function boolean(env: NodeJS.ProcessEnv, variable: string): boolean | undefined {
  const value = given(env, variable);
  if (value === undefined) return undefined;

  const parsed = BOOLEANS.get(value.toLowerCase());
  if (parsed === undefined) {
    throw new Error(
      `\`${variable}\` must be \`1\`, \`true\`, \`0\` or \`false\`, was \`${value}\``,
    );
  }

  return parsed;
}
