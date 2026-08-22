import { defineScript, type CommandParser, type RedisArgument } from "redis";

import { WRITE_TIME_FIELD } from "./entry-hash.js";
import { parseTagRefresh, type TagDurations, type TagRefresh } from "./tag-manifest.js";

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
    expiredAt = expiredAtOf(redis.call('HGET', KEYS[1], tag)) or now
  end
  redis.call('HSET', KEYS[1], tag, string.format('%d', now) .. ':' .. string.format('%d', expiredAt))
  redis.call('ZADD', KEYS[2], now, tag)
end
local cutoff = now - maxTtl
local stale = redis.call('ZRANGE', KEYS[2], '-inf', string.format('%d', cutoff), 'BYSCORE')
for index = 1, #stale do
  local tag = stale[index]
  local expiredAt = expiredAtOf(redis.call('HGET', KEYS[1], tag))
  if not expiredAt or expiredAt <= cutoff then
    redis.call('ZREM', KEYS[2], tag)
    redis.call('HDEL', KEYS[1], tag)
  end
end
return 1
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
 * The shape node-redis gives a defined script, spelled out because the package does
 * not export the type `defineScript` returns.
 */
export interface WriteEntryScript {
  SCRIPT: string;
  NUMBER_OF_KEYS: number;
  IS_READ_ONLY: boolean;
  SHA1: string;
  parseCommand(
    this: void,
    parser: CommandParser,
    key: RedisArgument,
    age: number,
    ttlSeconds: number,
    fields: readonly RedisArgument[],
  ): void;
  transformReply(this: void): void;
}

const writeEntryConfig: Omit<WriteEntryScript, "SHA1"> = {
  SCRIPT: WRITE_ENTRY,
  NUMBER_OF_KEYS: 1,
  IS_READ_ONLY: false,
  parseCommand(
    parser: CommandParser,
    key: RedisArgument,
    age: number,
    ttlSeconds: number,
    fields: readonly RedisArgument[],
  ) {
    parser.pushKey(key);
    parser.push(String(age), String(ttlSeconds), ...fields);
  },
  transformReply: (): void => undefined,
};

/**
 * The write unit of one Entry: the hash fields and the key TTL, plus the Write time
 * the script alone computes.
 *
 * It is a script rather than a `MULTI` because the Write time is `TIME - age` on the
 * Redis clock (ADR 0002) and a transaction cannot feed the reply of `TIME` into the
 * `HSET` that follows it. Every delay before the script runs therefore makes the Entry
 * look older, which is the safe side: an Entry is dropped, never wrongly served.
 */
export const writeEntryScript: WriteEntryScript = defineScript(writeEntryConfig);

/** The shape node-redis gives the tag write script. */
export interface UpdateTagsScript {
  SCRIPT: string;
  NUMBER_OF_KEYS: number;
  IS_READ_ONLY: boolean;
  SHA1: string;
  parseCommand(
    this: void,
    parser: CommandParser,
    manifestKey: RedisArgument,
    logKey: RedisArgument,
    maxTtlMs: number,
    durations: TagDurations,
    tags: readonly string[],
  ): void;
  transformReply(this: void): void;
}

const updateTagsConfig: Omit<UpdateTagsScript, "SHA1"> = {
  SCRIPT: UPDATE_TAGS,
  NUMBER_OF_KEYS: 2,
  IS_READ_ONLY: false,
  parseCommand(
    parser: CommandParser,
    manifestKey: RedisArgument,
    logKey: RedisArgument,
    maxTtlMs: number,
    durations: TagDurations,
    tags: readonly string[],
  ) {
    parser.pushKeys([manifestKey, logKey]);
    parser.push(String(maxTtlMs), durations.mode, String(durations.expireMs), ...tags);
  },
  transformReply: (): void => undefined,
};

/**
 * The one write of a tag event: per tag, the Tag manifest hash and the log, stamped with
 * the server clock the script alone reads, plus the pruning of events too old to affect
 * any living Entry.
 *
 * It is a script because a client timestamp or a `TIME` read in a separate round trip
 * both lose events under concurrency, and because the three `durations` forms need the
 * tag's current `expiredAt` to be read and rewritten without a race.
 */
export const updateTagsScript: UpdateTagsScript = defineScript(updateTagsConfig);

/** The shape node-redis gives the manifest read script. */
export interface ReadTagManifestScript {
  SCRIPT: string;
  NUMBER_OF_KEYS: number;
  IS_READ_ONLY: boolean;
  SHA1: string;
  parseCommand(this: void, parser: CommandParser, manifestKey: RedisArgument): void;
  transformReply(this: void, reply: unknown): TagRefresh;
}

const readTagManifestConfig: Omit<ReadTagManifestScript, "SHA1"> = {
  SCRIPT: READ_TAG_MANIFEST,
  NUMBER_OF_KEYS: 1,
  IS_READ_ONLY: true,
  parseCommand(parser: CommandParser, manifestKey: RedisArgument) {
    parser.pushKey(manifestKey);
  },
  transformReply: (reply: unknown): TagRefresh => parseTagRefresh(reply),
};

/**
 * The full read of the Tag manifest: the whole hash and the server clock it was read at,
 * in one round trip. `HGETALL` alone would leave the comparison in `get` without a Redis
 * clock to compare against, and reading `TIME` separately would be a second round trip
 * on a value that must match the manifest it is used with.
 */
export const readTagManifestScript: ReadTagManifestScript = defineScript(readTagManifestConfig);
