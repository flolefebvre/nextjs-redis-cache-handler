import { hashFieldsOf } from "./hash-reply.js";
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
export function decodeEntryHash(hash: Map<string, unknown>): StoredEntry | undefined {
  const value = decodeBytes(hash.get(VALUE_FIELD));
  const tags = decodeTags(hash.get(TAGS_FIELD));
  const stale = decodeNumber(hash.get(STALE_FIELD));
  const timestamp = decodeNumber(hash.get(TIMESTAMP_FIELD));
  const expire = decodeNumber(hash.get(EXPIRE_FIELD));
  const revalidate = decodeNumber(hash.get(REVALIDATE_FIELD));
  const writeTime = decodeNumber(hash.get(WRITE_TIME_FIELD));

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

/**
 * The Entry the read script's reply holds, or `undefined` when the key held no hash.
 *
 * The reply is the flat field/value array of an `HGETALL`, read through the binary type
 * mapping that script declares, so every field of it is bytes — the names included, which
 * the pairing decodes. A reply that is not a hash at all throws, where a hash that is not
 * an Entry this version wrote is a miss: the first is a store answering something it should
 * not, the second is a key another version of this library owns.
 */
export function parseEntryReply(reply: unknown): StoredEntry | undefined {
  return decodeEntryHash(hashFieldsOf(reply));
}
