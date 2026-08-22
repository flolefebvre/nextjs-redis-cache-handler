import type { CacheClient } from "./client.js";
import { encodeTagDurations, type TagRefresh } from "./tag-manifest.js";

/**
 * Where the Tag manifest lives: the hash of tag states and the log of event times. The
 * braces are a Cluster hash tag, so both keys always land in the same slot (ADR 0001).
 */
export function tagKeys(keyPrefix: string): { manifest: string; log: string } {
  return { manifest: `${keyPrefix}{tags}`, log: `${keyPrefix}{tags}:log` };
}

/**
 * Record that `tags` were made Stale or Expired, at the server's clock. The caller has
 * checked that there is at least one tag: an empty list is not a round trip.
 */
export async function writeTagEvents(
  client: CacheClient,
  keyPrefix: string,
  tags: readonly string[],
  durations: { expire?: number } | undefined,
  maxTtl: number,
): Promise<void> {
  const keys = tagKeys(keyPrefix);

  await client.updateTagManifest(
    keys.manifest,
    keys.log,
    maxTtl * 1000,
    encodeTagDurations(durations),
    tags,
  );
}

/** The whole Tag manifest, with the server clock it was read at, in one round trip. */
export function readTagManifest(client: CacheClient, keyPrefix: string): Promise<TagRefresh> {
  return client.readTagManifest(tagKeys(keyPrefix).manifest);
}
