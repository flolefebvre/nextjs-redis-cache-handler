import type { CacheClient } from "./client.js";
import { runScript } from "./script-runner.js";
import {
  readTagManifestScript,
  readTagManifestSinceScript,
  tickScript,
  updateTagsScript,
} from "./scripts.js";
import { encodeTagDurations, type TagRefresh } from "./tag-manifest.js";
import type { Timestamp } from "./types.js";

/**
 * Where the tag slot lives: the hash of tag states, the log of event times, and the
 * Handler clock every stamp is issued from (ADR 0003). The braces are a Cluster hash tag,
 * so the three keys always land in the same slot (ADR 0001).
 */
export function tagKeys(keyPrefix: string): { manifest: string; log: string; clock: string } {
  return {
    manifest: `${keyPrefix}{tags}`,
    log: `${keyPrefix}{tags}:log`,
    clock: `${keyPrefix}{tags}:clock`,
  };
}

/**
 * Issue one stamp of the Handler clock: the instant an Entry written right after is dated
 * from, never earlier than any stamp issued before it (ADR 0003).
 *
 * It is a round trip of its own because the clock lives in the tag slot, which the script
 * writing an Entry into the Entry's own slot cannot reach on Cluster. Only `set` pays for
 * it, and `set` is off the request's critical path; a `get` issues no stamp at all.
 */
export function tickHandlerClock(client: CacheClient, keyPrefix: string): Promise<Timestamp> {
  return runScript(client, tickScript, [tagKeys(keyPrefix).clock], []);
}

/**
 * Record that `tags` were made Stale or Expired, at the Handler clock the script stamps
 * them with. The caller has checked that there is at least one tag: an empty list is not
 * a round trip.
 */
export async function writeTagEvents(
  client: CacheClient,
  keyPrefix: string,
  tags: readonly string[],
  durations: { expire?: number } | undefined,
  maxTtl: number,
): Promise<void> {
  const keys = tagKeys(keyPrefix);
  const events = encodeTagDurations(durations);

  await runScript(
    client,
    updateTagsScript,
    [keys.manifest, keys.log, keys.clock],
    [String(maxTtl * 1000), events.mode, String(events.expireMs), ...tags],
  );
}

/** The whole Tag manifest, with the Handler clock it was read at, in one round trip. */
export function readTagManifest(client: CacheClient, keyPrefix: string): Promise<TagRefresh> {
  const keys = tagKeys(keyPrefix);

  return runScript(client, readTagManifestScript, [keys.manifest, keys.clock], []);
}

/**
 * The tag events written since `since`, with their manifest values and the Handler clock
 * they were read at, in one round trip. `since` is a log score, and the reply carries
 * every member scored at or after it.
 *
 * `undefined` means the log holds fewer tags than the manifest does, so it lost events
 * the manifest still holds and only a full read can bring them back.
 */
export function readTagManifestSince(
  client: CacheClient,
  keyPrefix: string,
  since: Timestamp,
): Promise<TagRefresh | undefined> {
  const keys = tagKeys(keyPrefix);

  return runScript(
    client,
    readTagManifestSinceScript,
    [keys.manifest, keys.log, keys.clock],
    [String(Math.floor(since))],
  );
}
