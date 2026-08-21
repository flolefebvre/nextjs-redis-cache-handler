// PROTOTYPE (throwaway). Shared helpers for the refreshTags read measurement.
import { createClient } from 'redis';

export const URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6390';
export const H = 'proto:tags:h';      // hash: tag -> "staleAt:expiredAt" (ms)
export const LOG = 'proto:tags:log';  // zset: tag -> server write time (ms)

// Atomic write: server TIME as the timestamp, hash + log updated together.
// ARGV[1] = expire seconds or "" (undefined => expired now). KEYS = [H, LOG]; ARGV[2..] = tags.
export const WRITE = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local expire = ARGV[1]
local expiredAt = now
if expire ~= '' then expiredAt = now + tonumber(expire) * 1000 end
for i = 2, #ARGV do
  redis.call('HSET', KEYS[1], ARGV[i], now .. ':' .. expiredAt)
  redis.call('ZADD', KEYS[2], now, ARGV[i])
end
return now
`;

// Watermark read in one round trip: tags written at or after ARGV[1] (inclusive),
// their values, and the server time to use as the next watermark.
export const READ_SINCE = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local tags = redis.call('ZRANGEBYSCORE', KEYS[2], ARGV[1], '+inf')
local values = {}
for i = 1, #tags, 1000 do
  local chunk = {}
  for j = i, math.min(#tags, i + 999) do chunk[#chunk + 1] = tags[j] end
  local part = redis.call('HMGET', KEYS[1], unpack(chunk))
  for j = 1, #part do values[#values + 1] = part[j] end
end
return { now, tags, values }
`;

export async function connect() {
  const c = createClient({ url: URL });
  c.on('error', (e) => console.error('redis error', e.message));
  await c.connect();
  return c;
}

export async function writeTags(client, tags, expire) {
  return Number(await client.eval(WRITE, { keys: [H, LOG], arguments: [expire == null ? '' : String(expire), ...tags] }));
}

export async function readSince(client, watermark) {
  const [now, tags, values] = await client.eval(READ_SINCE, { keys: [H, LOG], arguments: [String(watermark)] });
  return { now: Number(now), tags, values };
}

export function tagName(i) {
  // realistic mix: explicit tags and soft (path) tags
  return i % 3 === 0 ? `_N_T_/blog/post-${i}` : i % 3 === 1 ? `product:${100000 + i}` : `user:${i}:orders`;
}

export function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
