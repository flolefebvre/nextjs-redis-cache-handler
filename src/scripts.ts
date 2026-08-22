import { createHash } from "node:crypto";

import { WRITE_TIME_FIELD } from "./entry-hash.js";
import { parseStamp } from "./handler-clock.js";
import { parseTagRefresh, type TagRefresh } from "./tag-manifest.js";
import type { Timestamp } from "./types.js";

const HANDLER_NOW = `
local clock = redis.call('TIME')
local wallNow = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local function handlerNow(key)
  local last = tonumber(redis.call('GET', key)) or 0
  if wallNow > last then return wallNow, true end
  return last, false
end
`;

/**
 * The Lua that issues one stamp of the Handler clock: the wall clock, floored by the last
 * stamp the key holds, and persisted whenever it moved the clock on. A stamp taken while
 * the wall clock sits behind that floor writes nothing — the value is already there, and a
 * `SET` of it would be replication traffic for an unchanged key (ADR 0003).
 */
function stamp(clockKey: string): string {
  return `${HANDLER_NOW}
local now, ahead = handlerNow(${clockKey})
if ahead then redis.call('SET', ${clockKey}, string.format('%d', now)) end
`;
}

/**
 * The Lua that reads the Handler clock without issuing a stamp: the same value, persisted
 * by nobody. A read runs on every request of every Instance, and the verdict it feeds
 * compares stamps that the stamping scripts issued — so a read has nothing to record, and
 * recording it would put one write per request into the replication stream and the AOF for
 * good (ADR 0003).
 */
function readClock(clockKey: string): string {
  return `${HANDLER_NOW}
local now = handlerNow(${clockKey})
`;
}

const TICK = `${stamp("KEYS[1]")}
return string.format('%d', now)
`;

const EXPIRED_AT_OF = `
local function expiredAtOf(value)
  if not value then return nil end
  local separator = string.find(value, ':', 1, true)
  if not separator then return nil end
  return tonumber(string.sub(value, separator + 1))
end
`;

const PRUNE_BATCH = 100;

const UPDATE_TAGS = `
${EXPIRED_AT_OF}
local maxTtl = tonumber(ARGV[1])
local mode = ARGV[2]
local expireMs = tonumber(ARGV[3])
${stamp("KEYS[3]")}
for index = 4, #ARGV do
  local tag = ARGV[index]
  local expiredAt = now
  if mode == 'expire-after' then
    expiredAt = now + expireMs
  elseif mode == 'expire-unchanged' then
    expiredAt = expiredAtOf(redis.call('HGET', KEYS[1], tag)) or 0
  end
  redis.call('HSET', KEYS[1], tag, string.format('%d', now) .. ':' .. string.format('%d', expiredAt))
  redis.call('ZADD', KEYS[2], now, tag)
end
local cutoff = wallNow - maxTtl
local batch = redis.call('ZRANGE', KEYS[2], '-inf', string.format('%d', cutoff), 'BYSCORE', 'LIMIT', 0, ${PRUNE_BATCH})
for index = 1, #batch do
  local tag = batch[index]
  local expiredAt = expiredAtOf(redis.call('HGET', KEYS[1], tag))
  if not expiredAt or expiredAt <= cutoff then
    redis.call('ZREM', KEYS[2], tag)
    redis.call('HDEL', KEYS[1], tag)
  else
    redis.call('ZADD', KEYS[2], now, tag)
  end
end
return 1
`;

const HMGET_CHUNK = 1000;

const READ_TAG_MANIFEST_SINCE = `
${readClock("KEYS[3]")}
if redis.call('ZCARD', KEYS[2]) < redis.call('HLEN', KEYS[1]) then return false end
local tags = redis.call('ZRANGE', KEYS[2], ARGV[1], '+inf', 'BYSCORE')
local fields = {}
for start = 1, #tags, ${HMGET_CHUNK} do
  local stop = math.min(#tags, start + ${HMGET_CHUNK} - 1)
  local values = redis.call('HMGET', KEYS[1], unpack(tags, start, stop))
  for index = 1, #values do
    if values[index] then
      fields[#fields + 1] = tags[start + index - 1]
      fields[#fields + 1] = values[index]
    end
  end
end
return { string.format('%d', now), string.format('%d', wallNow), fields }
`;

const READ_TAG_MANIFEST = `
${readClock("KEYS[2]")}
return { string.format('%d', now), string.format('%d', wallNow), redis.call('HGETALL', KEYS[1]) }
`;

const WRITE_ENTRY = `
local writeTime = ARGV[1]
local ttl = tonumber(ARGV[2])
redis.call('HSET', KEYS[1], '${WRITE_TIME_FIELD}', writeTime, unpack(ARGV, 3))
redis.call('EXPIRE', KEYS[1], ttl)
return 1
`;

/**
 * One Lua script this handler runs, with the digest `EVALSHA` needs and the parsing of
 * its reply.
 *
 * The scripts are not bound to the client with node-redis's `scripts` option: a client
 * the caller injected was created without them, and node-redis 6 offers no way to add
 * scripts to a client it did not create. They are run by `runScript` instead, over
 * `sendCommand`, which every client has whatever its own scripts, RESP version or socket.
 */
export interface CacheScript<Reply> {
  /** The Lua source, sent by `EVAL` when the server does not know the digest yet. */
  SCRIPT: string;
  /** How many of the arguments that follow are keys, as `EVAL` counts them. */
  NUMBER_OF_KEYS: number;
  /** The digest of `SCRIPT`, as `EVALSHA` names it. */
  SHA1: string;
  /** What the script's reply means, or a throw when the server answered something else. */
  transformReply(this: void, reply: unknown): Reply;
}

function defineCacheScript<Reply>(
  script: string,
  numberOfKeys: number,
  transformReply: (this: void, reply: unknown) => Reply,
): CacheScript<Reply> {
  return {
    SCRIPT: script,
    NUMBER_OF_KEYS: numberOfKeys,
    SHA1: createHash("sha1").update(script).digest("hex"),
    transformReply,
  };
}

/**
 * One stamp of the Handler clock, the single source of every instant this handler
 * compares (ADR 0003): `max(TIME, last)` in milliseconds, persisted when it moved the
 * clock on, and returned.
 *
 * It touches the clock key and nothing else, so it is routable on Cluster on its own,
 * and it is the first of the two round trips a `set` makes: the Entry write that follows
 * carries the Write time this stamp gives it.
 *
 * Keys: the Handler clock. No arguments.
 */
export const tickScript: CacheScript<Timestamp> = defineCacheScript(TICK, 1, parseStamp);

/**
 * The write unit of one Entry: the hash fields, the Write time the caller computed from
 * a stamp of the Handler clock, and the key TTL.
 *
 * It stays a script rather than becoming a `MULTI` of the same two commands: it is one
 * round trip either way, it keeps the `HSET` and the `EXPIRE` in one atomic unit, and it
 * needs nothing of the client the transaction shape would ask for. It reads no clock of
 * its own — the Handler clock lives in the `{tags}` slot, which an Entry's own slot
 * cannot reach on Cluster — so the Write time is `stamp - age`, computed by the caller.
 * Every delay between the stamp and this write therefore makes the Entry look older,
 * which is the safe side: an Entry is dropped, never wrongly served (ADR 0002).
 *
 * The TTL is the caller's, already counted from the Write time and always at least one
 * second: no Entry outlives `min(expire, maxTtl)` counted from its Write time, which is
 * what lets the tag events older than `maxTtl` be pruned. The age is the app's number
 * (ADR 0002), so the arithmetic that takes it off the lifetime lives beside the decision
 * not to write an Entry that has none left, and not here.
 *
 * Arguments: the Write time in milliseconds, the TTL in seconds, then the hash fields.
 */
export const writeEntryScript: CacheScript<void> = defineCacheScript(
  WRITE_ENTRY,
  1,
  (): void => undefined,
);

/**
 * The one write of a tag event: per tag, the Tag manifest hash and the log, stamped with
 * the Handler clock the script alone issues, plus the pruning of events too old to affect
 * any living Entry.
 *
 * It is a script because a client timestamp or a stamp read in a separate round trip
 * both lose events under concurrency, and because the three `durations` forms need the
 * tag's current `expiredAt` to be read and rewritten without a race. A tag never made
 * Expired keeps `expiredAt` at `0`, which no Entry can ever be older than, so that a
 * profile without an `expire` marks the tag Stale and nothing more.
 *
 * Pruning drops the events older than `maxTtl` of the server's wall clock — the clock the
 * Entry keys expire on, and one the Handler clock is never below — on the invariant the
 * write script keeps:
 * no Entry outlives `min(expire, maxTtl)` counted from its Write time, so no living Entry
 * has a Write time older than the cutoff and no dropped event can still be the verdict on
 * one. Pruning walks at most one batch of the oldest log members per call, and re-adds at the
 * current time every member it examined but could not drop. A log score therefore means
 * "when the tag was last written, or last examined for pruning", never more than one
 * `maxTtl` behind the tag's own event: without the re-add, tags with a far-future
 * expiration would sit at the front of the log forever and be re-read on every single
 * tag event. The watermark read of a later version sees such a re-added member once per
 * `maxTtl` and overwrites its local state with the identical value.
 *
 * Keys: the Tag manifest hash, its log and the Handler clock. Arguments: `maxTtl` in
 * milliseconds, the `durations` mode and its expiration, then the tags.
 */
export const updateTagsScript: CacheScript<void> = defineCacheScript(
  UPDATE_TAGS,
  3,
  (): void => undefined,
);

/**
 * The full read of the Tag manifest: the whole hash, the Handler clock it was read at and
 * the server's wall clock, in one round trip. `HGETALL` alone would leave the comparison in
 * `get` without a clock to compare against, and reading the clock separately would be a
 * second round trip on a value that must match the manifest it is used with. The read
 * issues no stamp (ADR 0003).
 *
 * Keys: the Tag manifest hash and the Handler clock. No arguments.
 */
export const readTagManifestScript: CacheScript<TagRefresh> = defineCacheScript(
  READ_TAG_MANIFEST,
  2,
  parseTagRefresh,
);

/**
 * The incremental read of the Tag manifest: the Handler clock, the server's wall clock,
 * the log members written since the caller's watermark, and their manifest values, in one
 * round trip. Its cost
 * is that of the events since the last read, whatever the size of the manifest, where a
 * full read grows with the manifest and stalls the server for every Instance.
 *
 * The values are read in chunks of a thousand fields because one `HMGET` of every member
 * would build an argument list the Lua stack cannot take. A member the write script has
 * pruned between the `ZRANGE` and the `HMGET` carries no value and is left out entirely:
 * a tag the shared copy no longer holds is one no living Entry can be affected by.
 *
 * The read rests on the invariant the write script keeps: every tag of the hash is a
 * member of the log, so the two always hold the same number of tags. A log holding fewer
 * than the hash was evicted or deleted, and an empty reply would then be indistinguishable
 * from "no events since the watermark" while the hash still holds events never read. The
 * script answers nothing at all in that case, so that the caller reads the manifest whole
 * instead of advancing its watermark past them.
 *
 * Keys: the Tag manifest hash, its log and the Handler clock. Arguments: the log score to
 * read from.
 */
export const readTagManifestSinceScript: CacheScript<TagRefresh | undefined> = defineCacheScript(
  READ_TAG_MANIFEST_SINCE,
  3,
  (reply: unknown): TagRefresh | undefined =>
    reply === null || reply === undefined ? undefined : parseTagRefresh(reply),
);
