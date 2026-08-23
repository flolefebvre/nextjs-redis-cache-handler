import type { RedisArgument } from "redis";

import {
  clientKind,
  type CacheClient,
  type CacheCommands,
  type ClusterCacheCommands,
  type SentinelCacheCommands,
} from "./client.js";
import type { CacheScript } from "./scripts.js";

const NO_SCRIPT = "NOSCRIPT";
const DEFAULT_TYPE_MAPPING = {};
const WRITES = false;

/**
 * The keys one script declares, first the one it is routed by. It is a non-empty list
 * because a Cluster client sends a command to the node owning that first key, and a script
 * with no key would have no node to go to (ADR 0001).
 */
export type ScriptKeys = readonly [RedisArgument, ...RedisArgument[]];

/**
 * Run one Lua script and read its reply.
 *
 * `EVALSHA` first and the whole source only when the server answers `NOSCRIPT`, which is
 * what node-redis does for the scripts it binds itself: a script is sent once per server,
 * and a server that was restarted or had its script cache flushed is caught by the very
 * next call rather than by an error.
 *
 * The reply is read through the default type mapping, whatever mapping the caller's own
 * client carries: a `BLOB_STRING` mapped to `Buffer`, say, would otherwise turn every
 * field of the Tag manifest into bytes the parser does not expect.
 */
export async function runScript<Reply>(
  client: CacheClient,
  script: CacheScript<Reply>,
  keys: ScriptKeys,
  args: readonly RedisArgument[],
): Promise<Reply> {
  const send = sender(client, keys[0]);
  const tail = [String(script.NUMBER_OF_KEYS), ...keys, ...args];
  const reply = await send(["EVALSHA", script.SHA1, ...tail]).catch((error: unknown) => {
    if (!isNoScript(error)) throw error;

    return send(["EVAL", script.SCRIPT, ...tail]);
  });

  return script.transformReply(reply);
}

/**
 * How this client is sent a command: the one place the three node-redis clients differ.
 *
 * A Sentinel client is told whether the command may run on a replica, and a Cluster client
 * is told that and the key that routes it. Both answers are fixed here. Every script is a
 * write — `EVALSHA_RO` is Redis 7.0 and up while this library's floor is 6.2, and nothing
 * the handler runs reads a replica — and every script is routable by its first key, which
 * each of them declares as `KEYS[1]`: the Entry scripts touch one Entry key, and the tag
 * scripts touch the manifest, its log and the Handler clock, which the hash tag of ADR
 * 0001 pins to one slot.
 *
 * The kind was established structurally by `clientKind`; the assertions are what tell the
 * compiler which arm of the union that answer picked.
 */
function sender(
  client: CacheClient,
  firstKey: RedisArgument,
): (command: readonly RedisArgument[]) => Promise<unknown> {
  const commands = client.withTypeMapping(DEFAULT_TYPE_MAPPING);
  const kind = clientKind(client);

  if (kind === "cluster") {
    const cluster = commands as ClusterCacheCommands;

    return (command) => cluster.sendCommand(firstKey, WRITES, command);
  }
  if (kind === "sentinel") {
    const sentinel = commands as SentinelCacheCommands;

    return (command) => sentinel.sendCommand(WRITES, command);
  }

  const standalone = commands as CacheCommands;

  return (command) => standalone.sendCommand(command);
}

function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(NO_SCRIPT);
}
