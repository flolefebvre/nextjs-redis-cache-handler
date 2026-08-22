import { RESP_TYPES } from "redis";

import type { CacheClient } from "./client.js";
import {
  decodeEntryHash,
  encodeEntryFields,
  type BufferedEntry,
  type StoredEntry,
} from "./entry-hash.js";
import { runScript } from "./script-runner.js";
import { writeEntryScript } from "./scripts.js";
import type { Timestamp } from "./types.js";

const NEVER_EXPIRES = 4_294_967_294;
const BINARY_VALUES = { [RESP_TYPES.BLOB_STRING]: Buffer };

/** Where one Entry lives: the Key prefix, used verbatim, then Next.js's cache key raw. */
export function entryKey(keyPrefix: string, cacheKey: string): string {
  return `${keyPrefix}entry:${cacheKey}`;
}

/**
 * How long the Entry key lives, counted from the Write time: its `expire`, capped by
 * `maxTtl`, minus the age the Entry already carries. Next.js says "never" either as
 * `Infinity` or as the sentinel it normalises `Infinity` to, and both always clamp to
 * `maxTtl`, whatever it is — the age comes off that cap too.
 *
 * The age is rounded up to the second so that the key is never the short rounding of a
 * second too long-lived: the prune rules of the Tag manifest compare in milliseconds
 * against `maxTtl` counted from the Write time, and a key outliving that window is an
 * Entry those rules have already dropped the tag events of.
 *
 * A result of zero or less means the Entry has already lived its whole lifetime and must
 * not be written at all: `EXPIRE` takes no such value, and a key given the one second it
 * would be raised to would outlive the invariant by that second.
 */
export function entryTtlSeconds(expire: number, maxTtl: number, age: number): number {
  const lifetime =
    !Number.isFinite(expire) || expire >= NEVER_EXPIRES
      ? maxTtl
      : Math.min(Math.floor(expire), maxTtl);

  return lifetime - Math.ceil(age / 1000);
}

/**
 * How old the Entry is at the moment it is written, measured on the app's clock alone so
 * that skew against the server cancels out (ADR 0002). An Entry that claims to have been
 * generated in the future is treated as generated now: a Write time ahead of the stamp it
 * is taken from would let the Entry survive tag events that came after it.
 */
export function entryAge(timestamp: Timestamp, appNow: Timestamp): number {
  return Math.max(0, appNow - timestamp);
}

/**
 * Write the Entry and its TTL in one atomic unit, stamped with the Write time the caller
 * took from the Handler clock.
 */
export async function writeEntry(
  client: CacheClient,
  key: string,
  entry: BufferedEntry,
  writeTime: Timestamp,
  ttlSeconds: number,
): Promise<void> {
  await runScript(
    client,
    writeEntryScript,
    [key],
    [String(Math.floor(writeTime)), String(ttlSeconds), ...encodeEntryFields(entry)],
  );
}

/**
 * The Entry the key holds, or `undefined` when it holds none. The value is read with
 * binary type mapping: decoding an RSC payload as UTF-8 would corrupt it.
 */
export async function readEntry(
  client: CacheClient,
  key: string,
): Promise<StoredEntry | undefined> {
  const hash = await client.withTypeMapping(BINARY_VALUES).hGetAll(key);

  return decodeEntryHash(hash);
}
