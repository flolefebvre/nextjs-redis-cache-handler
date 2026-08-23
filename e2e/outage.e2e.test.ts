import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { LOG_PREFIX } from "../src/events.js";
import { stopwatch } from "../tests/unit-harness.js";
import {
  canPauseStore,
  startInstances,
  type InstanceName,
  type OwnStoreInstances,
} from "./instances.js";
import { POST, postMarkers, postMarkersOnceChanged } from "./pages.js";
import { outcomesOf, type RecordedCall } from "./records.js";

/** The deadline both Instances of this Scenario run every awaited operation under. */
const OPERATION_TIMEOUT = 1_000;

/**
 * The budget `updateTags` retries within here: shorter than the library's default, so that
 * the whole outage stays inside the window a frozen server is still answered `timeout`
 * within, and so that the Scenario spends two seconds waiting in CI rather than five.
 */
const UPDATE_TAGS_TIMEOUT = 2_000;

/**
 * An upper bound on the operations one request to the post page waits on serially: the Tag
 * manifest refresh, the read of each of its three cached scopes, and the expiration check.
 * Every one of them is bounded by `operationTimeout`, so the page owes its 200 within that
 * many deadlines plus the time it takes to render every scope uncached.
 */
const STALLED_OPERATIONS = 5;

/** What rendering the whole post page with nothing cached is given, on a loaded CI runner. */
const RENDER_MARGIN = 3_000;

/** What a request to the post page owes while the store is stalled. */
const PAGE_DEADLINE = OPERATION_TIMEOUT * STALLED_OPERATIONS + RENDER_MARGIN;

/**
 * What a failing action owes: its invalidation's whole budget, and then the render of the
 * response Next.js answers the failure with — itself a page render under the outage.
 */
const ACTION_DEADLINE = UPDATE_TAGS_TIMEOUT + PAGE_DEADLINE;

/**
 * What Next.js answers a Server Action whose `updateTags` rejected: the rejected write is
 * awaited after the action body ran, and surfaces there as a failed request.
 */
const ACTION_FAILURE = 500;

/**
 * How a read of a stalled store can be Recorded: `timeout` while node-redis still holds the
 * frozen socket, `unavailable` from the moment its idle timeout has torn that socket down
 * and the reconnect loop is running. Which one a read lands on is the age of the pause,
 * which no instant of a Scenario's clock names.
 */
const OUTAGE_MISSES = ["get miss:timeout", "get miss:unavailable"];

/** What the invalidation that ran out of its budget reported through `onError`. */
const GAVE_UP = "did not succeed within";

/** What Node.js prints when a rejection reaches it: the thing this Scenario owes none of. */
const UNHANDLED = ["UnhandledPromiseRejection", "unhandledRejection"];

const INSTANCES: InstanceName[] = ["A", "B"];

/**
 * The Fixture on a store this Scenario alone runs on, so that it may freeze it: the run's
 * shared store is never paused, every other Scenario is talking to it. Its own store is
 * seeded from nothing, so the narrative starts by warming what the outage then breaks.
 *
 * Skipped when `CACHE_TEST_REDIS_URL` names a server the suite was only lent, for the same
 * reason the outage integration tests are: a provided server is nobody's to pause.
 */
describe.skipIf(!canPauseStore())("through an outage of its own store", () => {
  let instances!: OwnStoreInstances;

  beforeAll(async () => {
    instances = await startInstances("outage", {
      store: "own",
      env: {
        NEXT_REDIS_CACHE_OPERATION_TIMEOUT: String(OPERATION_TIMEOUT),
        NEXT_REDIS_CACHE_UPDATE_TAGS_TIMEOUT: String(UPDATE_TAGS_TIMEOUT),
      },
    });
  });

  afterAll(async () => {
    await instances?.stop();
  });

  /** What one Instance answered the post page with, and how long the caller waited. */
  async function served(instance: InstanceName): Promise<{ status: number; waitedMs: number }> {
    const elapsed = stopwatch();
    const { status } = await instances.get(instance, POST);

    return { status, waitedMs: elapsed() };
  }

  test("both Instances warm one Entry on the store they alone share", async () => {
    const from = await instances.calls.end();

    const a = await postMarkers(instances, "A");
    await instances.calls.waitFor(from, (call) => call.method === "set");
    const b = await postMarkers(instances, "B");

    expect(b).toEqual(a);
    expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get hit");
  });

  test("while the store is stalled, both Instances still serve the page, and miss", async () => {
    await instances.store.pause();
    const from = await instances.calls.end();

    const a = await served("A");
    const b = await served("B");

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(Math.max(a.waitedMs, b.waitedMs)).toBeLessThan(PAGE_DEADLINE);
    const calls = await instances.calls.since(from);
    expect(missedOf(calls, "A")).not.toHaveLength(0);
    expect(missedOf(calls, "B")).not.toHaveLength(0);
  });

  test("the action on A fails within its budget, and the failure is Recorded", async () => {
    const from = await instances.calls.end();

    const elapsed = stopwatch();
    const status = await instances.action("A", "invalidatePosts");
    const waitedMs = elapsed();

    expect(status).toBe(ACTION_FAILURE);
    expect(waitedMs).toBeGreaterThanOrEqual(UPDATE_TAGS_TIMEOUT - OPERATION_TIMEOUT);
    expect(waitedMs).toBeLessThan(ACTION_DEADLINE);
    expect(outcomesOf(await instances.calls.since(from), "A")).toContain("updateTags error");
  });

  test("once the store answers again, each Instance reads the Tag manifest again", async () => {
    await instances.store.unpause();
    const from = await instances.calls.end();

    await instances.markersOnceStable("A", POST, "post-body");
    await instances.markersOnceStable("B", POST, "post-body");

    const calls = await instances.calls.since(from);
    expect(outcomesOf(calls, "A")).toContain("refreshTags ok");
    expect(outcomesOf(calls, "B")).toContain("refreshTags ok");
  });

  test("propagation resumes: `updateTag` on A expires the Entry B reads next", async () => {
    const before = await postMarkers(instances, "B");
    const from = await instances.calls.end();

    expect(await instances.action("A", "invalidatePosts")).toBe(200);
    const after = await postMarkersOnceChanged(instances, "B", "post-body", before["post-body"]);

    expect(after["comments"]).toBe(before["comments"]);
    expect(outcomesOf(await instances.calls.since(from), "B")).toContain("get miss:expired");
  });

  test("each Instance reported the outage, and neither left a rejection unhandled", async () => {
    expect(await instances.logged("A", `${LOG_PREFIX} get`)).not.toHaveLength(0);
    expect(await instances.logged("B", `${LOG_PREFIX} get`)).not.toHaveLength(0);
    expect((await instances.logged("A", `${LOG_PREFIX} updateTags`)).join("\n")).toContain(GAVE_UP);

    const unhandled = await Promise.all(
      INSTANCES.flatMap((instance) =>
        UNHANDLED.map((text) => instances.loggedSoFar(instance, text)),
      ),
    );

    expect(unhandled.flat()).toEqual([]);
  });
});

/** Which of the two misses an outage can be Recorded as one Instance actually Recorded. */
function missedOf(calls: RecordedCall[], instance: InstanceName): string[] {
  const outcomes = outcomesOf(calls, instance);

  return OUTAGE_MISSES.filter((outcome) => outcomes.has(outcome));
}
