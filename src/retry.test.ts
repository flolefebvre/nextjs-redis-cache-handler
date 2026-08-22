import { describe, expect, test } from "vitest";

import { DeadlineError } from "./deadline.js";
import { GaveUpError, withRetries, type RetryBudget } from "./retry.js";

const BUDGET = 300;

const ATTEMPT_TIMEOUT = 60;

const BACKOFF = 20;

const BACKOFF_CAP = 80;

const MARGIN = 120;

const WRITTEN = "written";

const SHORT_BUDGET = 1;

const OUTLASTING = SHORT_BUDGET + 1;

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
    mark: () => at.push(Date.now()),
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
    const startedAt = Date.now();

    const retried = withRetries("updateTags", budget(), () => Promise.reject(new Error("no")));

    await expect(retried).rejects.toBeInstanceOf(GaveUpError);
    const waitedMs = Date.now() - startedAt;
    expect(waitedMs).toBeGreaterThanOrEqual(BUDGET - BACKOFF);
    expect(waitedMs).toBeLessThan(BUDGET + MARGIN);
  });

  test("bounds every attempt on its own, so a stalled one does not spend the budget", async () => {
    const attempts = starts();
    const startedAt = Date.now();

    const retried = withRetries("updateTags", budget(), async () => {
      attempts.mark();
      await wait(BUDGET * 2);
    });

    await expect(retried).rejects.toMatchObject({ cause: expect.any(DeadlineError) });
    expect(attempts.at.length).toBeGreaterThan(1);
    expect(Date.now() - startedAt).toBeLessThan(BUDGET + MARGIN);
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
    expect(gaps.at(1) ?? 0).toBeGreaterThanOrEqual(BACKOFF * 2);
    expect(Math.max(...gaps)).toBeLessThan(BACKOFF_CAP + MARGIN);
  });
});
