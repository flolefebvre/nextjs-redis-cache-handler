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

/** How an operation that kept failing for its whole budget failed: the last attempt's failure is the `cause`. */
export class GaveUpError extends Error {
  constructor(operation: string, budgetMs: number, cause: unknown) {
    super(`\`${operation}\` did not succeed within ${String(budgetMs)}ms`, { cause });
    this.name = "GaveUpError";
  }
}

/**
 * Retry one operation until it succeeds or its budget is spent: what the first attempt to
 * succeed gave back, or a `GaveUpError` naming the operation and the budget, carrying the
 * last attempt's failure as its `cause`.
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
