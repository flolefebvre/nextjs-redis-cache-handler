import type { RedisArgument } from "redis";

import type { CacheClient } from "./client.js";
import type { CacheScript } from "./scripts.js";

const NO_SCRIPT = "NOSCRIPT";
const DEFAULT_TYPE_MAPPING = {};

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
  keys: readonly RedisArgument[],
  args: readonly RedisArgument[],
): Promise<Reply> {
  const commands = client.withTypeMapping(DEFAULT_TYPE_MAPPING);
  const tail = [String(script.NUMBER_OF_KEYS), ...keys, ...args];
  const reply = await commands
    .sendCommand(["EVALSHA", script.SHA1, ...tail])
    .catch((error: unknown) => {
      if (!isNoScript(error)) throw error;

      return commands.sendCommand(["EVAL", script.SCRIPT, ...tail]);
    });

  return script.transformReply(reply);
}

function isNoScript(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(NO_SCRIPT);
}
