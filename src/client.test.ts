import { expect, test } from "vitest";

import { reconnectDelay } from "./client.js";

const CAP_WITH_JITTER = 2_200;

test("the first attempts back off, from 50 ms up", () => {
  expect(reconnectDelay(0)).toBeGreaterThanOrEqual(50);
  expect(reconnectDelay(0)).toBeLessThan(reconnectDelay(5));
});

test("every attempt count, however large, is a bounded delay and never a refusal", () => {
  for (const retries of [0, 1, 10, 53, 1_024, 1e6, Number.MAX_SAFE_INTEGER]) {
    const delay: unknown = reconnectDelay(retries);

    expect(typeof delay).toBe("number");
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(CAP_WITH_JITTER);
  }
});
