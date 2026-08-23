import { describe, expect, test } from "vitest";

import { stopwatch } from "../tests/unit-harness.js";
import { DeadlineError } from "./deadline.js";
import { GaveUpError, withRetries, type RetryBudget } from "./retry.js";

const BUDGET = 300;

const ATTEMPT_TIMEOUT = 60;

const BACKOFF = 20;

const BACKOFF_CAP = 80;

const MARGIN = 120;

/**
 * How early a timer may fire, measured against the monotonic clock: Node's event loop
 * keeps its time in whole milliseconds, so a pause of `n` ms can read as a hair under it.
 */
const TIMER_SLACK = 1;

const WRITTEN = "written";

const SHORT_BUDGET = 1;

const OUTLASTING = SHORT_BUDGET + 1;

const WRONG_TYPE = "WRONGTYPE Operation against a key holding the wrong kind of value";

/** Reply errors no retry can turn into a success: the loop must end on the first of them. */
const FINAL_REPLIES = [
  WRONG_TYPE,
  "NOPERM this user has no permissions to run the 'hset' command",
  "OOM command not allowed when used memory > 'maxmemory'",
  "NOAUTH Authentication required",
  "WRONGPASS invalid username-password pair or user is disabled",
  "ERR Error running script (call to f_0123): @user_script:12: WRONGTYPE Operation against a key holding the wrong kind of value",
];

/** Reply errors naming a state that clears by itself, which the loop must ride out. */
const TRANSIENT_REPLIES = [
  "LOADING Redis is loading the dataset in memory",
  "BUSY Redis is busy running a script",
  "MASTERDOWN Link with MASTER is down and replica-serve-stale-data is set to 'no'",
  "READONLY You can't write against a read only replica",
  "NOREPLICAS Not enough good replicas to write",
  "CLUSTERDOWN The cluster is down",
  "TRYAGAIN Multiple keys request during rehashing of slot",
  "MOVED 3999 127.0.0.1:6381",
  "ASK 3999 127.0.0.1:6381",
];

/** What node-redis raises off the wire rather than from a reply, which the loop must ride out too. */
const OFF_THE_WIRE = [
  "The client is closed",
  "The client is offline",
  "Socket closed unexpectedly",
  "Connection timeout",
  "connect ECONNREFUSED 127.0.0.1:6379",
];

const RETRIED_FAILURES = [...TRANSIENT_REPLIES, ...OFF_THE_WIRE];

function budget(overrides: Partial<RetryBudget> = {}): RetryBudget {
  return {
    budgetMs: BUDGET,
    attemptTimeoutMs: ATTEMPT_TIMEOUT,
    backoffMs: BACKOFF,
    backoffCapMs: BACKOFF_CAP,
    ...overrides,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What every attempt of one call did, as the test that watches them reads it. */
type Attempts = { at: number[]; mark: () => void; gaps: () => number[] };

/** An attempt that always succeeds, recorded as it starts. */
function succeeding(attempts: Attempts): () => Promise<string> {
  return () => {
    attempts.mark();

    return Promise.resolve(WRITTEN);
  };
}

/**
 * An attempt that outlasts `OUTLASTING` milliseconds before it rejects, spinning rather
 * than awaiting: a blocked event loop leaves the attempt's own deadline unable to fire,
 * so the rejection is the one this hands back.
 */
function outlasting(attempts: Attempts, failure: Error): () => Promise<never> {
  return () => {
    attempts.mark();
    const until = performance.now() + OUTLASTING;
    while (performance.now() < until);

    return Promise.reject(failure);
  };
}

/** When every attempt started, counted from the first one. */
function starts(): Attempts {
  const at: number[] = [];

  return {
    at,
    mark: () => at.push(performance.now()),
    gaps: () => at.slice(1).map((start, index) => start - (at[index] ?? start)),
  };
}

describe("withRetries", () => {
  test("gives back what the first attempt returned, having run it once", async () => {
    const attempts = starts();

    const returned = await withRetries("updateTags", budget(), succeeding(attempts));

    expect(returned).toBe(WRITTEN);
    expect(attempts.at).toHaveLength(1);
  });

  test("retries a failing attempt and gives back what the one that succeeded returned", async () => {
    const attempts = starts();

    const returned = await withRetries("updateTags", budget(), () => {
      attempts.mark();

      return attempts.at.length < 3 ? Promise.reject(new Error("no")) : Promise.resolve(WRITTEN);
    });

    expect(returned).toBe(WRITTEN);
    expect(attempts.at).toHaveLength(3);
  });

  test("retries an attempt that throws before any await", async () => {
    const attempts = starts();

    const returned = await withRetries("updateTags", budget(), () => {
      attempts.mark();
      if (attempts.at.length < 2) throw new Error("thrown before any await");

      return Promise.resolve(WRITTEN);
    });

    expect(returned).toBe(WRITTEN);
    expect(attempts.at).toHaveLength(2);
  });

  test("runs one attempt even on a budget too short to schedule anything in", async () => {
    const attempts = starts();

    const returned = await withRetries(
      "updateTags",
      budget({ budgetMs: SHORT_BUDGET }),
      succeeding(attempts),
    );

    expect(returned).toBe(WRITTEN);
    expect(attempts.at).toHaveLength(1);
  });

  test("gives up on the first failure of a budget one attempt already outlasts", async () => {
    const attempts = starts();
    const failure = new Error("the store said no");

    const retried = withRetries(
      "updateTags",
      budget({ budgetMs: SHORT_BUDGET }),
      outlasting(attempts, failure),
    );

    await expect(retried).rejects.toBeInstanceOf(GaveUpError);
    expect(attempts.at).toHaveLength(1);
    await expect(retried).rejects.toHaveProperty("cause", failure);
  });

  test("gives up once the budget is spent, naming the operation and the budget", async () => {
    const failure = new Error("the store said no");

    const retried = withRetries("updateTags", budget(), () => Promise.reject(failure));

    await expect(retried).rejects.toBeInstanceOf(GaveUpError);
    await expect(retried).rejects.toThrow(/updateTags/);
    await expect(retried).rejects.toThrow(new RegExp(String(BUDGET)));
  });

  test("carries the last attempt's failure as the cause of giving up", async () => {
    const attempts = starts();
    let last = new Error("none");

    const retried = withRetries<never>("updateTags", budget(), () => {
      attempts.mark();
      last = new Error(`attempt ${String(attempts.at.length)}`);

      return Promise.reject(last);
    });

    const settled: unknown = await retried.catch((error: unknown) => error);

    expect(settled).toHaveProperty("cause", last);
    expect(attempts.at.length).toBeGreaterThan(1);
  });

  test("gives up within the budget, whatever the attempts cost", async () => {
    const elapsed = stopwatch();

    const retried = withRetries("updateTags", budget(), () => Promise.reject(new Error("no")));

    await expect(retried).rejects.toBeInstanceOf(GaveUpError);
    const waitedMs = elapsed();
    expect(waitedMs).toBeGreaterThanOrEqual(BUDGET - BACKOFF);
    expect(waitedMs).toBeLessThan(BUDGET + MARGIN);
  });

  test("bounds every attempt on its own, so a stalled one does not spend the budget", async () => {
    const attempts = starts();
    const elapsed = stopwatch();

    const retried = withRetries("updateTags", budget(), async () => {
      attempts.mark();
      await wait(BUDGET * 2);
    });

    await expect(retried).rejects.toMatchObject({ cause: expect.any(DeadlineError) });
    expect(attempts.at.length).toBeGreaterThan(1);
    expect(elapsed()).toBeLessThan(BUDGET + MARGIN);
  });

  test("waits longer between attempts as they keep failing, up to the cap", async () => {
    const attempts = starts();

    const retried = withRetries("updateTags", budget(), () => {
      attempts.mark();

      return Promise.reject(new Error("no"));
    });

    await expect(retried).rejects.toBeInstanceOf(GaveUpError);
    const gaps = attempts.gaps();
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    expect(gaps.at(0) ?? 0).toBeLessThan(BACKOFF * 2);
    expect(gaps.at(1) ?? 0).toBeGreaterThanOrEqual(BACKOFF * 2 - TIMER_SLACK);
    expect(Math.max(...gaps)).toBeLessThan(BACKOFF_CAP + MARGIN);
  });
});

describe("withRetries, on a reply error", () => {
  test.each(FINAL_REPLIES)("stops at once on %s", async (message) => {
    const attempts = starts();

    const retried = withRetries("updateTags", budget(), () => {
      attempts.mark();

      return Promise.reject(new Error(message));
    });

    await expect(retried).rejects.toBeInstanceOf(GaveUpError);
    expect(attempts.at).toHaveLength(1);
  });

  test.each(RETRIED_FAILURES)("keeps retrying %s", async (message) => {
    const attempts = starts();

    const returned = await withRetries("updateTags", budget(), () => {
      attempts.mark();

      return attempts.at.length < 2 ? Promise.reject(new Error(message)) : Promise.resolve(WRITTEN);
    });

    expect(returned).toBe(WRITTEN);
    expect(attempts.at).toHaveLength(2);
  });

  test("keeps retrying a deadline", async () => {
    const attempts = starts();

    const returned = await withRetries("updateTags", budget(), () => {
      attempts.mark();

      return attempts.at.length < 2
        ? Promise.reject(new DeadlineError(ATTEMPT_TIMEOUT))
        : Promise.resolve(WRITTEN);
    });

    expect(returned).toBe(WRITTEN);
    expect(attempts.at).toHaveLength(2);
  });

  test("gives up the same way, naming the operation and the reply code", async () => {
    const failure = new Error(WRONG_TYPE);
    const elapsed = stopwatch();

    const retried = withRetries("updateTags", budget(), () => Promise.reject(failure));

    await expect(retried).rejects.toBeInstanceOf(GaveUpError);
    await expect(retried).rejects.toHaveProperty("cause", failure);
    await expect(retried).rejects.toThrow(/updateTags/);
    await expect(retried).rejects.toThrow(/WRONGTYPE/);
    expect(elapsed()).toBeLessThan(BUDGET);
  });
});
