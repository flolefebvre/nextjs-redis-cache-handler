import { withDeadline } from "./deadline.js";

/** The first pause between two attempts, in milliseconds: what a retried operation starts from. */
export const RETRY_BACKOFF = 50;

/** The longest pause between two attempts, in milliseconds, however many have failed. */
export const RETRY_BACKOFF_CAP = 500;

/**
 * How long an operation may keep trying, and how it paces its attempts: the total budget,
 * the deadline of one attempt, and the backoff that doubles from `backoffMs` up to
 * `backoffCapMs`.
 */
export interface RetryBudget {
  budgetMs: number;
  attemptTimeoutMs: number;
  backoffMs: number;
  backoffCapMs: number;
}

/**
 * The reply codes a retry is worth waiting through: every one of them names a state the
 * server clears on its own — loading its dataset (`LOADING`), running someone else's
 * script (`BUSY`), a replica whose link to its master is down (`MASTERDOWN`), a node
 * demoted by a failover in flight (`READONLY`), a cluster reshaping or reshaping a slot
 * this command needs (`CLUSTERDOWN`, `TRYAGAIN`, `MOVED`, `ASK`). That criterion, not the
 * list, is what a code added here has to meet.
 *
 * `MOVED` and `ASK` are the Cluster client's own business and should never reach this
 * loop; they are named here for the one that escapes it, which a later attempt follows.
 */
const TRANSIENT_REPLY_CODES = new Set([
  "LOADING",
  "BUSY",
  "MASTERDOWN",
  "READONLY",
  "CLUSTERDOWN",
  "TRYAGAIN",
  "MOVED",
  "ASK",
]);

/**
 * What a server reply error opens with: the all-caps code Redis and Valkey put in front of
 * every error reply, `WRONGTYPE`, `NOPERM` or the catch-all `ERR` among them.
 */
const REPLY_CODE = /^[A-Z][A-Z0-9_]+(?= |$)/;

/**
 * How an operation the retry loop ended on failed: the failure it ended on is the `cause`,
 * whether the budget ran out under a store that kept failing or a reply error ended the
 * loop before it.
 */
export class GaveUpError extends Error {
  constructor(operation: string, budgetMs: number, cause: unknown, replyCode?: string) {
    super(gaveUpOn(operation, budgetMs, replyCode), { cause });
    this.name = "GaveUpError";
  }
}

/**
 * The reply code of a failure no retry can turn into a success, or `undefined` for a
 * failure worth attempting again: a reply error whose code names no self-clearing state —
 * `WRONGTYPE` on a corrupted key, `NOPERM` from an ACL, `OOM`, the `ERR` a failing script
 * comes back as — cannot succeed however long the budget is, so the loop ends on it.
 *
 * Everything else is retried: a deadline, whatever node-redis raises off the wire rather
 * than from a reply — a closed client, a socket closed under it, a refused connection —
 * and any failure whose message is not shaped like a reply at all. The two mistakes do not
 * cost the same. Reading a transient failure as final loses an invalidation and fails a
 * Server Action a retry would have saved; reading a final failure as transient costs the
 * budget and nothing else. So the shape check is tight and the list of self-clearing codes
 * is closed: in doubt, this retries.
 */
function finalReplyCode(error: unknown): string | undefined {
  const code = error instanceof Error ? REPLY_CODE.exec(error.message)?.[0] : undefined;
  if (code === undefined || TRANSIENT_REPLY_CODES.has(code)) return undefined;

  return code;
}

function gaveUpOn(operation: string, budgetMs: number, replyCode?: string): string {
  return replyCode === undefined
    ? `\`${operation}\` did not succeed within ${String(budgetMs)}ms`
    : `\`${operation}\` failed with \`${replyCode}\`, which retrying cannot fix`;
}

/**
 * Retry one operation until it succeeds or its budget is spent: what the first attempt to
 * succeed gave back, or a `GaveUpError` naming the operation and the budget, carrying the
 * last attempt's failure as its `cause`.
 *
 * A failure retrying cannot fix ends the loop where it happened, on the same
 * `GaveUpError` and the same `cause`, naming the reply code instead of the budget: a
 * reply error whose code names no self-clearing state is what the store will answer to
 * every further attempt, so the caller waits for none of them.
 *
 * The budget is the total, not the per-attempt allowance: every attempt is bounded by
 * `withDeadline` at the smaller of `attemptTimeoutMs` and what is left of the budget, and
 * every pause is cut short at the budget's end, so the caller waits `budgetMs` and no
 * more — a failure at the very edge of the budget is a `GaveUpError` rather than one more
 * attempt. The first attempt always runs, whatever the budget: it is bounded by the
 * budget itself rather than by what is left of it, so a budget already spent by the time
 * the loop starts still sends one command.
 *
 * The budget is spent on the monotonic clock, so a host clock stepping backwards mid-retry
 * does not extend it.
 *
 * Only an operation whose retry is safe belongs here: an attempt that failed may still
 * have landed, which the next one then repeats.
 *
 * The backoff timers are unref'd, so a pending retry never holds a process open.
 */
export async function withRetries<T>(
  operation: string,
  budget: RetryBudget,
  attempt: () => Promise<T>,
): Promise<T> {
  const endsAt = performance.now() + budget.budgetMs;
  let backoffMs = budget.backoffMs;
  let failure: unknown;
  let attempted = false;
  const gaveUp = (): GaveUpError => new GaveUpError(operation, budget.budgetMs, failure);

  for (;;) {
    const left = endsAt - performance.now();
    if (attempted && left <= 0) throw gaveUp();

    const bound = attempted ? left : budget.budgetMs;
    attempted = true;
    try {
      return await withDeadline(Math.min(budget.attemptTimeoutMs, bound), attempt);
    } catch (error) {
      failure = error;
      const replyCode = finalReplyCode(error);
      if (replyCode !== undefined)
        throw new GaveUpError(operation, budget.budgetMs, error, replyCode);
    }

    const remaining = endsAt - performance.now();
    if (remaining <= 0) throw gaveUp();

    await pause(Math.min(backoffMs, remaining));
    backoffMs = Math.min(backoffMs * 2, budget.backoffCapMs);
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
