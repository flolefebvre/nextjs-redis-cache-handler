import type { Timestamp } from "./types.js";

const BAD_REPLY = "unreadable handler clock reply";

/**
 * The instant one stamp of the Handler clock came back as, the script having formatted it
 * as an integer string.
 *
 * A reply that is not a number at all throws rather than being read as `NaN`: a `NaN`
 * Write time would be stamped on the Entry and compared against every tag event for as
 * long as the Entry lives. The throw makes the write a failed `set` instead, which the
 * handler reports and drops.
 */
export function parseStamp(reply: unknown): Timestamp {
  const readable = typeof reply === "number" || (typeof reply === "string" && reply.length > 0);
  const stamp = readable ? Number(reply) : NaN;
  if (!Number.isFinite(stamp)) throw new Error(BAD_REPLY);

  return stamp;
}
