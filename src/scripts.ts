import { defineScript, type CommandParser, type RedisArgument } from "redis";

import { WRITE_TIME_FIELD } from "./entry-hash.js";

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
