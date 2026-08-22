import { describe, expect, test } from "vitest";

import { DeadlineError, withDeadline } from "./deadline.js";

const SHORT = 20;

const LONG = 200;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withDeadline", () => {
  test("gives back what an operation that finished in time returned", async () => {
    await expect(withDeadline(LONG, () => Promise.resolve("in time"))).resolves.toBe("in time");
  });

  test("rejects with a DeadlineError once the operation has taken too long", async () => {
    const started = Date.now();

    const bounded = withDeadline(SHORT, () => wait(LONG));

    await expect(bounded).rejects.toBeInstanceOf(DeadlineError);
    expect(Date.now() - started).toBeLessThan(LONG);
  });

  test("lets the operation's own failure through, as it is", async () => {
    const failure = new Error("the store said no");

    const bounded = withDeadline(LONG, () => Promise.reject(failure));

    await expect(bounded).rejects.toBe(failure);
  });

  test("lets an operation ask whether the deadline has passed", async () => {
    const answers: boolean[] = [];

    const bounded = withDeadline(SHORT, async (passed) => {
      answers.push(passed());
      await wait(LONG);
      answers.push(passed());
    });

    await expect(bounded).rejects.toBeInstanceOf(DeadlineError);
    await wait(LONG);
    expect(answers).toEqual([false, true]);
  });

  test("rejects with a DeadlineError when the operation throws after the deadline", async () => {
    const bounded = withDeadline(SHORT, async () => {
      await wait(LONG);
      throw new Error("too late to matter");
    });

    await expect(bounded).rejects.toBeInstanceOf(DeadlineError);
    await wait(LONG);
  });

  test("rejects with what an operation that throws synchronously threw", async () => {
    const failure = new Error("thrown before any await");

    const bounded = withDeadline(LONG, () => {
      throw failure;
    });

    await expect(bounded).rejects.toBe(failure);
  });
});
