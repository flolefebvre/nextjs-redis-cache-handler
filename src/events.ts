const LOG_PREFIX = "[nextjs-redis-cache-handler]";
const NO_PHASE = "no-phase";

/** Why a read served nothing: the reason carried by a `miss` event. */
export type CacheMissReason = "absent" | "expired" | "timeout" | "unavailable";

/**
 * Why a write stored nothing: the reason carried by a `skip` event. `expire-zero` is an
 * Entry Next.js already hands over expired, `too-old` one whose age has consumed the
 * whole lifetime `min(expire, maxTtl)` gives it, counted from its Write time.
 */
export type CacheSkipReason = "too-large" | "expire-zero" | "too-old";

/**
 * One outcome of a `get` or a `set`, as `onEvent` receives it: discriminated on `type`,
 * always carrying the cache key and how long the operation took.
 *
 * `durationMs` is what the caller waited: for a read, the whole `get` including the wait
 * on a pending write of the same key; for a write, everything after the Entry's stream
 * has been buffered, since the render time before that is not the handler's.
 */
export type CacheEvent =
  /** An Entry was served, fresh. */
  | { type: "hit"; key: string; durationMs: number }
  /** Nothing was served, and why. */
  | { type: "miss"; reason: CacheMissReason; key: string; durationMs: number }
  /** An Entry was served for the wrapper to regenerate in the background. */
  | { type: "stale"; key: string; durationMs: number }
  /** An Entry was written to the store. */
  | { type: "set"; key: string; durationMs: number }
  /** An Entry was not written, why, and the size in bytes of the value dropped. */
  | { type: "skip"; reason: CacheSkipReason; size: number; key: string; durationMs: number };

/** The handler operation a failure happened in, as `onError` receives it. */
export type CacheErrorOp =
  "get" | "set" | "getExpiration" | "updateTags" | "refreshTags" | "connect";

/** What `onEvent` is: called once per `get` and per `set` outcome. Exceptions are ignored. */
export type CacheEventHook = (event: CacheEvent) => void;

/**
 * What `onError` is: called once per failure, with the operation. Exceptions are ignored.
 *
 * `updateTags` retries within its budget and reports once, on the failure it ends with,
 * so the attempts it made before that one are not reported.
 */
export type CacheErrorHook = (error: unknown, op: CacheErrorOp) => void;

/** The hook options of one handler object, as the reporter composes them. */
export interface ReporterHooks {
  onEvent?: CacheEventHook;
  onError?: CacheErrorHook;
  debug?: boolean;
}

/**
 * Where one handler object sends everything it observes. The only place a hook is
 * called, so the only place a hook exception is caught: nothing a caller's hook throws
 * ever reaches an operation, whether it throws or, when the hook is async, rejects.
 */
export interface CacheReporter {
  /** Report one outcome to every event hook installed. */
  emit(event: CacheEvent): void;
  /** Report one failure, in the named operation, to every error hook installed. */
  fail(error: unknown, op: CacheErrorOp): void;
}

/**
 * Compose the hooks of one handler object: the caller's, plus the console loggers `debug`
 * installs. Both run when both are given. The `console.error` default applies only when
 * neither `onError` nor `debug` is given, so that a caller who asked for either one is
 * never logged over.
 */
export function createReporter(hooks: ReporterHooks): CacheReporter {
  const debug = hooks.debug === true;
  const eventHooks = installed<CacheEventHook>(hooks.onEvent, debug ? logEvent : undefined);
  const given = installed<CacheErrorHook>(hooks.onError, debug ? logError : undefined);
  const errorHooks = given.length === 0 ? [defaultLogError] : given;

  return {
    emit(event: CacheEvent): void {
      for (const hook of eventHooks) guarded(() => hook(event));
    },
    fail(error: unknown, op: CacheErrorOp): void {
      for (const hook of errorHooks) guarded(() => hook(error, op));
    },
  };
}

function installed<T>(...hooks: (T | undefined)[]): T[] {
  return hooks.filter((hook): hook is T => hook !== undefined);
}

function guarded(call: () => unknown): void {
  try {
    const returned = call();
    if (returned instanceof Promise) void returned.catch(() => undefined);
  } catch {
    return;
  }
}

function logEvent(event: CacheEvent): void {
  console.log(
    `${LOG_PREFIX} [${phase()}] ${outcomeOf(event)} ${event.key} ${event.durationMs.toFixed(1)}ms`,
  );
}

function logError(error: unknown, op: CacheErrorOp): void {
  console.error(`${LOG_PREFIX} [${phase()}] error:${op}`, error);
}

function defaultLogError(error: unknown, op: CacheErrorOp): void {
  console.error(LOG_PREFIX, op, error);
}

function outcomeOf(event: CacheEvent): string {
  if (event.type === "skip") return `skip:${event.reason} ${event.size}B`;
  if (event.type === "miss") return `miss:${event.reason}`;

  return event.type;
}

function phase(): string {
  return process.env.NEXT_PHASE ?? NO_PHASE;
}
