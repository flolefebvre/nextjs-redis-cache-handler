/**
 * The behavioural half of the contract with Next.js: one Scenario, defined once, run
 * against the Oracle and against this handler, every step projected the same way and
 * asserted against the same expectation unless the step is a declared divergence.
 * `src/types.test.ts` is the shape half — it fails the typecheck when the interface moves,
 * this fails the suite when the behaviour behind it does.
 *
 * Two divergences are declared, and each is asserted positively so that ours going back to
 * matching the Oracle fails here: an Entry past its `revalidate`, which the Oracle misses
 * and ours serves once more, and `getExpiration`, which the Oracle answers with a timestamp
 * and ours with `Infinity`. A third one — `expire: 0`, "the Oracle stores and expires,
 * ours skips" — was retired: the Oracle only stores such an Entry on its dev-server branch,
 * and in production it skips the write exactly as ours does
 * (`docs/nextjs-caching.md`, `cacheLife`). It is a plain step of the Scenario now, and the
 * step a Next.js version that went back to storing it would fail.
 *
 * The Oracle's Tag manifest is a module-level singleton shared by every Oracle object of
 * the process, so no two steps ever name the same tag.
 */
import { describe, expect, test } from "vitest";

import { storeBefore, tick } from "../tests/handler-harness.js";
import {
  expectDivergence,
  expectProjection,
  PROJECTED_VALUE,
  projectRead,
  SUBJECTS,
  type ContractSubject,
  type ProjectedRead,
} from "../tests/oracle-harness.js";
import type { CacheEntry, CacheHandler, Timestamp } from "./types.js";

const STALE_SECONDS = 300;

const EXPIRE_SECONDS = 900;

const REVALIDATE_SECONDS = 60;

const PAST_EXPIRE_MS = (EXPIRE_SECONDS + REVALIDATE_SECONDS) * 1_000;

const PAST_REVALIDATE_MS = (REVALIDATE_SECONDS + 1) * 1_000;

const A_YEAR_SECONDS = 31_536_000;

/**
 * How far before the tag event that follows it an Entry is placed. The two handlers stamp
 * their events on two different readings of the host's wall clock — the Oracle on
 * `performance.timeOrigin + performance.now()`, ours on the Redis clock — and neither is
 * the `Date.now()` a step's anchor comes from, so the gap has to swamp the offset between
 * them rather than merely follow the `tick()` `storeBefore` already takes.
 */
const EVENT_GAP_MS = 1_000;

const TOLERANCE_MS = 1_000;

const MISS: ProjectedRead = { outcome: "miss" };

/**
 * What `getExpiration` came to, for a Soft tag just revalidated: the instant it was
 * revalidated at, which discards every Entry older than it, or `Infinity`, which leaves
 * the Soft-tag check to `get`. The second declared divergence, and the only one that is
 * not a step of the Scenario: it is the answer a read is projected through, not a read.
 *
 * The instant is read against the clock the answer was stamped on — the Oracle's own,
 * `performance.timeOrigin + performance.now()` — and never against `Date.now()`: the two
 * drift apart by whatever the host's wall clock stepped by since the process started, and
 * a correction wider than the tolerance would report a correct answer as a wrong instant.
 */
type ProjectedExpiration = { kind: "at the tag event" | "infinite" | "at another instant" };

const EXPIRATION: ProjectedExpiration = { kind: "at the tag event" };

const DIVERGENT_EXPIRATION: ProjectedExpiration = { kind: "infinite" };

function projectExpiration(expiration: Timestamp, anchor: Timestamp): ProjectedExpiration {
  if (expiration === Infinity) return DIVERGENT_EXPIRATION;

  return Math.abs(expiration - anchor) <= TOLERANCE_MS
    ? EXPIRATION
    : { kind: "at another instant" };
}

/** One step of the Scenario: what it drives, and what each side is expected to project. */
interface ScenarioStep {
  name: string;
  expected: ProjectedRead;
  divergent?: ProjectedRead;
  run(handler: CacheHandler, anchor: Timestamp): Promise<ProjectedRead>;
}

/** The Entry every step stores, aged by `ageMs` against the step's anchor. */
function scenarioEntry(
  tags: string[],
  anchor: Timestamp,
  ageMs = 0,
  overrides: Partial<CacheEntry> = {},
): Partial<CacheEntry> {
  return {
    tags,
    timestamp: anchor - ageMs,
    stale: STALE_SECONDS,
    expire: EXPIRE_SECONDS,
    revalidate: REVALIDATE_SECONDS,
    ...overrides,
  };
}

/** The projection of an Entry that was served, or served once more. */
function served(outcome: "hit" | "stale", tags: string[], ageMs = 0): ProjectedRead {
  return {
    outcome,
    tags,
    stale: STALE_SECONDS,
    ageMs,
    expire: EXPIRE_SECONDS,
    revalidate: outcome === "stale" ? -1 : REVALIDATE_SECONDS,
    value: PROJECTED_VALUE,
  };
}

/**
 * The projected read of a step that issued a tag event, taken a tick after it: an event
 * and a read inside the same millisecond of the wall clock are a tie neither handler
 * decides against the Entry — the Oracle stamps its events with a rounded millisecond and
 * compares them against the unrounded one — and no request Next.js serves lands in the
 * millisecond the revalidation that caused it was recorded in.
 */
function readAfterEvent(
  handler: CacheHandler,
  cacheKey: string,
  softTags: string[],
  anchor: Timestamp,
): Promise<ProjectedRead> {
  return tick().then(() => projectRead(handler, cacheKey, softTags, anchor));
}

const STEPS: ScenarioStep[] = [
  {
    name: "an Entry stored under a key is served back",
    expected: served("hit", ["stored:post"]),
    async run(handler, anchor) {
      await storeBefore(handler, "stored", scenarioEntry(["stored:post"], anchor));

      return projectRead(handler, "stored", [], anchor);
    },
  },
  {
    name: "a key nothing was stored under is a miss",
    expected: MISS,
    run(handler, anchor) {
      return projectRead(handler, "absent", [], anchor);
    },
  },
  {
    name: "a tag revalidated with no durations drops the Entry",
    expected: MISS,
    async run(handler, anchor) {
      await storeBefore(handler, "expired", scenarioEntry(["expired:post"], anchor, EVENT_GAP_MS));
      await handler.updateTags(["expired:post"]);

      return readAfterEvent(handler, "expired", [], anchor);
    },
  },
  {
    name: "a tag revalidated with an expiration serves the Entry once more",
    expected: served("stale", ["stale:post"], EVENT_GAP_MS),
    async run(handler, anchor) {
      await storeBefore(handler, "stale", scenarioEntry(["stale:post"], anchor, EVENT_GAP_MS));
      await handler.updateTags(["stale:post"], { expire: A_YEAR_SECONDS });

      return readAfterEvent(handler, "stale", [], anchor);
    },
  },
  {
    name: "an Entry that expires at once is never served",
    expected: MISS,
    async run(handler, anchor) {
      await storeBefore(
        handler,
        "dynamic",
        scenarioEntry(["dynamic:post"], anchor, 0, { expire: 0 }),
      );

      return projectRead(handler, "dynamic", [], anchor);
    },
  },
  {
    name: "a Soft tag revalidated after the Entry drops it",
    expected: MISS,
    async run(handler, anchor) {
      await storeBefore(handler, "soft", scenarioEntry(["soft:post"], anchor, EVENT_GAP_MS));
      await handler.updateTags(["soft:path"]);

      return readAfterEvent(handler, "soft", ["soft:path"], anchor);
    },
  },
  {
    name: "an Entry past its expire is a miss",
    expected: MISS,
    async run(handler, anchor) {
      await storeBefore(handler, "old", scenarioEntry(["old:post"], anchor, PAST_EXPIRE_MS));

      return projectRead(handler, "old", [], anchor);
    },
  },
  {
    name: "an Entry past its revalidate is a miss for the Oracle and served once more by ours",
    expected: MISS,
    divergent: served("stale", ["revalidate:post"], PAST_REVALIDATE_MS),
    async run(handler, anchor) {
      await storeBefore(
        handler,
        "revalidated",
        scenarioEntry(["revalidate:post"], anchor, PAST_REVALIDATE_MS),
      );

      return projectRead(handler, "revalidated", [], anchor);
    },
  },
  {
    name: "one tag of a nested union revalidated drops the Entry",
    expected: MISS,
    async run(handler, anchor) {
      const tags = ["nested:outer", "nested:inner"];
      await storeBefore(handler, "nested", scenarioEntry(tags, anchor, EVENT_GAP_MS));
      await handler.updateTags(["nested:inner"]);

      return readAfterEvent(handler, "nested", [], anchor);
    },
  },
];

describe.each(SUBJECTS)("$name", (subject: ContractSubject) => {
  test.each(STEPS)("$name", async (step: ScenarioStep) => {
    const handler = subject.create();
    const anchor = Date.now();

    const projection = await step.run(handler, anchor);

    expectProjection(projection, expectationFor(subject, step));
    if (step.divergent !== undefined) expectDivergence(step.divergent, step.expected);
  });

  test("the instant the Soft tags expired at is answered with, or left to get", async () => {
    const handler = subject.create();
    const anchor = performance.timeOrigin + performance.now();

    await handler.updateTags(["expiration:path"]);

    expect(projectExpiration(await handler.getExpiration(["expiration:path"]), anchor)).toEqual(
      subject.kind === "ours" ? DIVERGENT_EXPIRATION : EXPIRATION,
    );
    expect(DIVERGENT_EXPIRATION).not.toEqual(EXPIRATION);
  });
});

function expectationFor(subject: ContractSubject, step: ScenarioStep): ProjectedRead {
  return subject.kind === "ours" ? (step.divergent ?? step.expected) : step.expected;
}
