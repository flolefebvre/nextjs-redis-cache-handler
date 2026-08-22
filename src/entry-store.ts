import { RESP_TYPES } from "redis";

import type { CacheClient } from "./client.js";
import {
  decodeEntryHash,
  encodeEntryFields,
  type BufferedEntry,
  type StoredEntry,
} from "./entry-hash.js";
import type { Timestamp } from "./types.js";

const NEVER_EXPIRES = 4_294_967_294;

/** Where one Entry lives: the Key prefix, used verbatim, then Next.js's cache key raw. */
export function entryKey(keyPrefix: string, cacheKey: string): string {
  return `${keyPrefix}entry:${cacheKey}`;
}

/**
 * How long the Entry key lives: its `expire`, capped by `maxTtl`. Next.js says "never"
 * either as `Infinity` or as the sentinel it normalises `Infinity` to, and both always
 * clamp, whatever `maxTtl` is.
 */
export function entryTtlSeconds(expire: number, maxTtl: number): number {
  if (!Number.isFinite(expire) || expire >= NEVER_EXPIRES) return maxTtl;

  return Math.min(Math.floor(expire), maxTtl);
}

/**
 * How old the Entry is at the moment it is written, measured on the app's clock alone so
 * that skew against the server cancels out (ADR 0002). An Entry that claims to have been
 * generated in the future is treated as generated now: a Write time ahead of the server
 * clock would let the Entry survive tag events that came after it.
 */
export function entryAge(timestamp: Timestamp, appNow: Timestamp): number {
  return Math.max(0, appNow - timestamp);
}

/** Write the Entry and its TTL in one atomic unit, stamped with the Write time. */
export async function writeEntry(
  client: CacheClient,
  key: string,
  entry: BufferedEntry,
  age: number,
  ttlSeconds: number,
): Promise<void> {
  await client.writeEntryHash(key, age, ttlSeconds, encodeEntryFields(entry));
}

/**
 * The Entry the key holds, or `undefined` when it holds none. The value is read with
 * binary type mapping: decoding an RSC payload as UTF-8 would corrupt it.
 */
export async function readEntry(
  client: CacheClient,
  key: string,
): Promise<StoredEntry | undefined> {
  const hash = await client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer }).hGetAll(key);

  return decodeEntryHash(hash);
}
