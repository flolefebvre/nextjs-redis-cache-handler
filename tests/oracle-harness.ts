import { createDefaultCacheHandler } from "next/dist/server/lib/cache-handlers/default.js";
import { expect } from "vitest";

import type { CacheHandler, Timestamp } from "../src/types.js";
import { VALUE, bytesOf, freshPrefix, handlerFor } from "./handler-harness.js";

const ORACLE_MAX_SIZE = 50_000_000;

const TOLERANCE_MS = 1_000;

/**
 * The Entry value every Scenario stores, as a projected read carries it: base64, because
 * `VALUE` holds bytes no UTF-8 decoder gives back and two handlers can only be compared
 * on bytes that survive being turned into a string.
 */
export const PROJECTED_VALUE = Buffer.from(VALUE).toString("base64");

/**
 * The Oracle: Next.js's own in-memory Cache Handler, the reference every Scenario step is
 * measured against. It is a test-only deep import, never reachable from the shipped
 * files, which `pnpm pack:check` enforces.
 *
 * The Oracle branches on `__NEXT_DEV_SERVER`, and the dev branch serves Entries past
 * their `revalidate` and stores `expire: 0` ones — behaviour no deployment of this
 * library ever sees. A Scenario that ran against it would compare against the wrong
 * reference, so the variable being set is refused here rather than silently changing what
 * the contract means.
 */
export function oracleHandler(): CacheHandler {
  if (process.env.__NEXT_DEV_SERVER)
    throw new Error("the Oracle runs its dev branch while __NEXT_DEV_SERVER is set");

  return createDefaultCacheHandler(ORACLE_MAX_SIZE);
}

/** One side of the contract: a name for the report, and the handler object to drive. */
export interface ContractSubject {
  name: string;
  kind: "oracle" | "ours";
  /** The handler this Scenario step drives, built inside the test that drives it. */
  create(): CacheHandler;
}

/** The two sides every Scenario step runs against, in the order they are reported. */
export const SUBJECTS: ContractSubject[] = [
  { name: "the Oracle", kind: "oracle", create: oracleHandler },
  { name: "this handler", kind: "ours", create: () => handlerFor(freshPrefix()) },
];

/**
 * What one read came to, as the wrapper would read it: a miss, an Entry served, or an
 * Entry served once more while the wrapper regenerates it. Timings are relative to the
 * step's anchor — `ageMs` is how old the Entry claims to be — so that two runs taken at
 * two instants of the wall clock still project the same thing.
 */
export type ProjectedRead =
  | { outcome: "miss" }
  | {
      outcome: "hit" | "stale";
      tags: string[];
      stale: number;
      ageMs: number;
      expire: number;
      revalidate: number;
      value: string;
    };

/**
 * One read of `cacheKey`, projected the way the `'use cache'` wrapper reads it: the tag
 * state is taken in first, then `get` is handed the Soft tags, and an Entry that came back
 * is dropped when `getExpiration` names an instant it precedes — `Infinity` being the
 * answer that leaves the Soft-tag check to `get` itself (`docs/nextjs-caching.md`, "How a
 * read is interpreted", steps 3 and 5).
 *
 * Both sides go through it unchanged: the Oracle's `get` ignores its `softTags` argument,
 * so Soft tags only reach it through that rule, while ours answers `Infinity` and compares
 * them in `get`. What a render ends up serving is the same either way, which is what the
 * projection compares.
 */
export async function projectRead(
  handler: CacheHandler,
  cacheKey: string,
  softTags: string[],
  anchor: Timestamp,
): Promise<ProjectedRead> {
  await handler.refreshTags();
  const entry = await handler.get(cacheKey, softTags);
  if (entry === undefined) return { outcome: "miss" };

  const expiration = await handler.getExpiration(softTags);
  if (expiration !== Infinity && entry.timestamp <= expiration) return { outcome: "miss" };

  return {
    outcome: entry.revalidate === -1 ? "stale" : "hit",
    tags: entry.tags,
    stale: entry.stale,
    ageMs: anchor - entry.timestamp,
    expire: entry.expire,
    revalidate: entry.revalidate,
    value: Buffer.from(await bytesOf(entry.value)).toString("base64"),
  };
}

/** Assert a read projects to the expected one, its timings within a second of it. */
export function expectProjection(actual: ProjectedRead, expected: ProjectedRead): void {
  expect(agedAs(actual, expected)).toEqual(expected);
}

/**
 * Assert a declared divergence still is one: the projection this handler is asserted to
 * produce differs from the Oracle's, so that ours going back to matching the Oracle there
 * fails the Scenario instead of passing it quietly.
 */
export function expectDivergence(divergent: ProjectedRead, expected: ProjectedRead): void {
  expect(agedAs(divergent, expected)).not.toEqual(expected);
}

function agedAs(actual: ProjectedRead, expected: ProjectedRead): ProjectedRead {
  if (actual.outcome === "miss" || expected.outcome === "miss") return actual;
  if (Math.abs(actual.ageMs - expected.ageMs) > TOLERANCE_MS) return actual;

  return { ...actual, ageMs: expected.ageMs };
}
