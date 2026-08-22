import type { CacheEntry, Timestamp } from "./types.js";

/** An Entry whose value stream has been read into bytes. */
export type BufferedEntry = Omit<CacheEntry, "value"> & { value: Uint8Array };

/** A Buffered entry as it comes back from the store, with the Write time stamped on it. */
export type StoredEntry = BufferedEntry & { writeTime: Timestamp };

/**
 * The hash field holding the Write time. Written by the write script, the only place the
 * value is stored, and read back here.
 */
export const WRITE_TIME_FIELD = "writeTime";

const VALUE_FIELD = "value";
const TAGS_FIELD = "tags";
const STALE_FIELD = "stale";
const TIMESTAMP_FIELD = "timestamp";
const EXPIRE_FIELD = "expire";
const REVALIDATE_FIELD = "revalidate";

/**
 * The Entry as a flat list of hash field names and values, in the order `HSET` takes
 * them. The Write time is absent: the write script prepends the one its caller took from
 * the Handler clock.
 */
export function encodeEntryFields(entry: BufferedEntry): (string | Buffer)[] {
  return [
    VALUE_FIELD,
    Buffer.isBuffer(entry.value) ? entry.value : Buffer.from(entry.value),
    TAGS_FIELD,
    JSON.stringify(entry.tags),
    STALE_FIELD,
    String(entry.stale),
    TIMESTAMP_FIELD,
    String(entry.timestamp),
    EXPIRE_FIELD,
    String(entry.expire),
    REVALIDATE_FIELD,
    String(entry.revalidate),
  ];
}

/**
 * The Entry a hash holds, or `undefined` when the hash is absent, incomplete or
 * unreadable — a hash written by another version of this library is a miss, never a
 * throw.
 */
export function decodeEntryHash(hash: Record<string, unknown>): StoredEntry | undefined {
  const value = decodeBytes(hash[VALUE_FIELD]);
  const tags = decodeTags(hash[TAGS_FIELD]);
  const stale = decodeNumber(hash[STALE_FIELD]);
  const timestamp = decodeNumber(hash[TIMESTAMP_FIELD]);
  const expire = decodeNumber(hash[EXPIRE_FIELD]);
  const revalidate = decodeNumber(hash[REVALIDATE_FIELD]);
  const writeTime = decodeNumber(hash[WRITE_TIME_FIELD]);

  if (value === undefined || tags === undefined) return undefined;
  if (stale === undefined || timestamp === undefined) return undefined;
  if (expire === undefined || revalidate === undefined || writeTime === undefined) return undefined;

  return { value, tags, stale, timestamp, expire, revalidate, writeTime };
}

function decodeBytes(field: unknown): Buffer | undefined {
  return Buffer.isBuffer(field) ? field : undefined;
}

function decodeText(field: unknown): string | undefined {
  if (typeof field === "string") return field;

  return decodeBytes(field)?.toString();
}

function decodeNumber(field: unknown): number | undefined {
  const text = decodeText(field);
  if (text === undefined || text.length === 0) return undefined;

  const parsed = Number(text);

  return Number.isNaN(parsed) ? undefined : parsed;
}

function decodeTags(field: unknown): string[] | undefined {
  const text = decodeText(field);
  if (text === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== "string")) return undefined;

  return parsed as string[];
}
