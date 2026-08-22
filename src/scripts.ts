import { createHash } from "node:crypto";

import { WRITE_TIME_FIELD } from "./entry-hash.js";
import { parseTagRefresh, type TagRefresh } from "./tag-manifest.js";

const SERVER_NOW = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
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
${SERVER_NOW}
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
local cutoff = now - maxTtl
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
${SERVER_NOW}
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
return { string.format('%d', now), fields }
`;

const READ_TAG_MANIFEST = `
${SERVER_NOW}
return { string.format('%d', now), redis.call('HGETALL', KEYS[1]) }
`;

const WRITE_ENTRY = `
local age = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local writeTime = string.format('%d', math.floor(now - age))
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
 * The write unit of one Entry: the hash fields and the key TTL, plus the Write time
 * the script alone computes.
 *
 * It is a script rather than a `MULTI` because the Write time is `TIME - age` on the
 * Redis clock (ADR 0002) and a transaction cannot feed the reply of `TIME` into the
 * `HSET` that follows it. Every delay before the script runs therefore makes the Entry
 * look older, which is the safe side: an Entry is dropped, never wrongly served.
 *
 * Arguments: the age in milliseconds, the TTL in seconds, then the hash fields.
 */
export const writeEntryScript: CacheScript<void> = defineCacheScript(
  WRITE_ENTRY,
  1,
  (): void => undefined,
);

/**
 * The one write of a tag event: per tag, the Tag manifest hash and the log, stamped with
 * the server clock the script alone reads, plus the pruning of events too old to affect
 * any living Entry.
 *
 * It is a script because a client timestamp or a `TIME` read in a separate round trip
 * both lose events under concurrency, and because the three `durations` forms need the
 * tag's current `expiredAt` to be read and rewritten without a race. A tag never made
 * Expired keeps `expiredAt` at `0`, which no Entry can ever be older than, so that a
 * profile without an `expire` marks the tag Stale and nothing more.
 *
 * Pruning walks at most one batch of the oldest log members per call, and re-adds at the
 * current time every member it examined but could not drop. A log score therefore means
 * "when the tag was last written, or last examined for pruning", never more than one
 * `maxTtl` behind the tag's own event: without the re-add, tags with a far-future
 * expiration would sit at the front of the log forever and be re-read on every single
 * tag event. The watermark read of a later version sees such a re-added member once per
 * `maxTtl` and overwrites its local state with the identical value.
 *
 * Keys: the Tag manifest hash and its log. Arguments: `maxTtl` in milliseconds, the
 * `durations` mode and its expiration, then the tags.
 */
export const updateTagsScript: CacheScript<void> = defineCacheScript(
  UPDATE_TAGS,
  2,
  (): void => undefined,
);

/**
 * The full read of the Tag manifest: the whole hash and the server clock it was read at,
 * in one round trip. `HGETALL` alone would leave the comparison in `get` without a Redis
 * clock to compare against, and reading `TIME` separately would be a second round trip
 * on a value that must match the manifest it is used with.
 *
 * Keys: the Tag manifest hash. No arguments.
 */
export const readTagManifestScript: CacheScript<TagRefresh> = defineCacheScript(
  READ_TAG_MANIFEST,
  1,
  parseTagRefresh,
);

/**
 * The incremental read of the Tag manifest: the server clock, the log members written
 * since the caller's watermark, and their manifest values, in one round trip. Its cost
 * is that of the events since the last read, whatever the size of the manifest, where a
 * full read grows with the manifest and stalls the server for every Instance.
 *
 * The values are read in chunks of a thousand fields because one `HMGET` of every member
 * would build an argument list the Lua stack cannot take. A member the write script has
 * pruned between the `ZRANGE` and the `HMGET` carries no value and is left out entirely:
 * a tag the shared copy no longer holds is one no living Entry can be affected by.
 *
 * Keys: the Tag manifest hash and its log. Arguments: the log score to read from.
 */
export const readTagManifestSinceScript: CacheScript<TagRefresh> = defineCacheScript(
  READ_TAG_MANIFEST_SINCE,
  2,
  parseTagRefresh,
);
