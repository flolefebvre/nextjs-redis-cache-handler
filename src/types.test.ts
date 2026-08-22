import type {
  CacheEntry as NextCacheEntry,
  CacheHandler as NextCacheHandler,
  Timestamp as NextTimestamp,
} from "next/dist/server/lib/cache-handlers/types.js";
import { expect, test } from "vitest";

import type { CacheEntry, CacheHandler, Timestamp } from "./types.js";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const timestampMatchesNext: Equals<Timestamp, NextTimestamp> = true;
const entryMatchesNext: Equals<CacheEntry, NextCacheEntry> = true;
const handlerMatchesNext: Equals<CacheHandler, NextCacheHandler> = true;

test("the vendored handler types match the ones Next.js declares", () => {
  expect([timestampMatchesNext, entryMatchesNext, handlerMatchesNext]).toEqual([true, true, true]);
});
