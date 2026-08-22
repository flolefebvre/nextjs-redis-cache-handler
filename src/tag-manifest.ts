import type { Timestamp } from "./types.js";

/** The never sentinel Next.js normalises an infinite `expire` to, in seconds. */
const NEVER_EXPIRES = 4_294_967_294;

const STATE_SEPARATOR = ":";

const BAD_REPLY = "unreadable tag manifest reply";

/**
 * How far behind the watermark a read reaches, so that a backwards step of the Redis
 * clock too small to trip the full read is absorbed: an event stamped just below the
 * watermark is still read.
 */
const WATERMARK_MARGIN = 1_000;

/** When a tag was last made Stale and when it was last made Expired, on the Handler clock. */
export interface TagState {
  staleAt: Timestamp;
  expiredAt: Timestamp;
}

/**
 * What one refresh of the Tag manifest brings back: the tags to apply and the two clocks
 * they are read against. The Handler clock is what every stamp is compared on; the wall
 * clock comes back beside it because the Entry keys expire on that one, and it is the
 * cutoff the events no living Entry can be affected by are dropped at (ADR 0003).
 */
export interface TagRefresh {
  handlerNow: Timestamp;
  wallNow: Timestamp;
  states: Map<string, TagState>;
}

/** What the Tag manifest says about one Entry: serve it, serve it once more, or drop it. */
export type TagVerdict = "fresh" | "stale" | "expired";

/** The three shapes the `durations` argument of `updateTags` takes, as script arguments. */
export interface TagDurations {
  mode: "expire-now" | "expire-after" | "expire-unchanged";
  expireMs: number;
}

/**
 * The manifest a full read brought back: the Handler clock it was read at, and the tags
 * the hash held. A value written by another version of this library, or by anything
 * else, is dropped rather than parsed into a state that could hide an Entry; a reply
 * that is not a manifest at all throws, so that the caller keeps its previous copy
 * instead of behaving as if every tag were untouched.
 */
export function parseTagRefresh(reply: unknown): TagRefresh {
  if (!Array.isArray(reply) || reply.length !== 3) throw new Error(BAD_REPLY);

  const handlerNow = Number(reply[0]);
  const wallNow = Number(reply[1]);
  const fields: unknown = reply[2];
  if (!Number.isFinite(handlerNow) || !Number.isFinite(wallNow)) throw new Error(BAD_REPLY);
  if (!Array.isArray(fields) || fields.length % 2 !== 0) throw new Error(BAD_REPLY);

  const states = new Map<string, TagState>();
  for (let index = 0; index < fields.length; index += 2) {
    const state = parseTagState(String(fields[index + 1]));
    if (state !== undefined) states.set(String(fields[index]), state);
  }

  return { handlerNow, wallNow, states };
}

function parseTagState(value: string): TagState | undefined {
  const parts = value.split(STATE_SEPARATOR);
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return undefined;

  const staleAt = Number(parts[0]);
  const expiredAt = Number(parts[1]);
  if (!Number.isFinite(staleAt) || !Number.isFinite(expiredAt)) return undefined;

  return { staleAt, expiredAt };
}

/**
 * The `durations` argument as the write script reads it. The three forms Next.js sends
 * mean three different things and none of them can be inferred from a number alone:
 * absent expires the tags now, `{ expire: N }` (`0` included) expires them N seconds from
 * now, and `durations` without an `expire` keeps whatever expiration the tags already had.
 */
export function encodeTagDurations(durations: { expire?: number } | undefined): TagDurations {
  if (durations === undefined) return { mode: "expire-now", expireMs: 0 };
  if (durations.expire === undefined) return { mode: "expire-unchanged", expireMs: 0 };

  const expire = Number.isFinite(durations.expire) ? durations.expire : NEVER_EXPIRES;

  return { mode: "expire-after", expireMs: expire * 1000 };
}

/**
 * What the manifest says about an Entry written at `writeTime`, as of `handlerNow` — both
 * on the Handler clock (ADR 0002, ADR 0003), never the app clock.
 *
 * A tag expired since the Entry was written drops it; a tag made Stale since then has it
 * served once more while the wrapper regenerates it. An expired tag wins over a Stale one,
 * so every tag is looked at before a Stale verdict is returned.
 *
 * An event stamped on the very millisecond of the Write time counts as later than it: the
 * Handler clock advances with time and not with the number of stamps taken (ADR 0003), so
 * two of them can share an instant, and the tie goes to the event — the side that drops an
 * Entry rather than serving output a mutation replaced.
 */
export function tagVerdict(
  states: Map<string, TagState>,
  tags: readonly string[],
  softTags: readonly string[],
  writeTime: Timestamp,
  handlerNow: Timestamp,
): TagVerdict {
  let stale = false;

  for (const tag of [...tags, ...softTags]) {
    const state = states.get(tag);
    if (state === undefined) continue;

    if (state.expiredAt <= handlerNow && state.expiredAt >= writeTime) return "expired";
    if (state.staleAt >= writeTime) stale = true;
  }

  return stale ? "stale" : "fresh";
}

/** One Instance's copy of the Tag manifest, refreshed before every request. */
export interface TagManifest {
  /** Take the whole manifest a refresh brought back, dropping the previous copy. */
  replaceWith(refresh: TagRefresh): void;
  /**
   * Take in an incremental refresh: the tags it carries overwrite the ones held, the
   * others are kept, and the tags no living Entry can be affected by any more are
   * dropped.
   *
   * `false` means the refresh could not be merged — no refresh has landed in this copy
   * yet, or its clock is behind the watermark, which is what a read taken across a
   * backward step of the Redis host's wall clock brings back (ADR 0003) — and that the
   * copy was left exactly as it was, so that the caller takes a full read in that same
   * call rather than on the next one.
   */
  mergeWith(refresh: TagRefresh): boolean;
  /**
   * The log score a watermark read must start at: the last refresh's Handler clock less a
   * one second margin, which absorbs a backwards step of that clock small enough to leave
   * the watermark standing. It is `undefined` while no refresh has landed, which is
   * what makes the first read of a process a full one.
   */
  since(): Timestamp | undefined;
  /**
   * The Handler clock as of now, or `undefined` while no refresh has landed in this
   * process. It is the last refresh's instant plus the time elapsed since, measured on a
   * monotonic clock so that a step of the app's clock cannot move it.
   *
   * A refresh never takes back time already counted: while the shared clock is frozen at
   * its floor — the whole of a backward step of the Redis host's wall clock (ADR 0003) —
   * every refresh would otherwise bring the same instant back and this copy would stop
   * advancing, holding a tag expiration that was due meanwhile. The copy therefore keeps
   * the later of the two, which puts it at most one step ahead of the shared clock, and
   * being ahead only ever drops an Entry sooner.
   */
  handlerNow(): Timestamp | undefined;
  /** What the local copy says about an Entry; the caller has checked `handlerNow` first. */
  verdictFor(
    tags: readonly string[],
    softTags: readonly string[],
    writeTime: Timestamp,
  ): TagVerdict;
}

/**
 * Build the empty local copy one handler object keeps for its process. `maxTtlMs` is the
 * Entry TTL cap in milliseconds: the age past which a tag event is dropped from the copy.
 */
export function createTagManifest(maxTtlMs: number): TagManifest {
  let states = new Map<string, TagState>();
  let anchor: { handlerNow: Timestamp; elapsedFrom: number } | undefined;
  let watermark: Timestamp | undefined;

  function handlerNow(): Timestamp | undefined {
    if (anchor === undefined) return undefined;

    return anchor.handlerNow + (performance.now() - anchor.elapsedFrom);
  }

  function anchorOn(refresh: TagRefresh): void {
    const counted = handlerNow() ?? 0;
    anchor = {
      handlerNow: Math.max(refresh.handlerNow, counted),
      elapsedFrom: performance.now(),
    };
    watermark = refresh.handlerNow;
  }

  return {
    replaceWith(refresh: TagRefresh): void {
      states = refresh.states;
      anchorOn(refresh);
    },
    mergeWith(refresh: TagRefresh): boolean {
      if (watermark === undefined || refresh.handlerNow < watermark) return false;

      for (const [tag, state] of refresh.states) states.set(tag, state);
      prune(states, refresh.wallNow - maxTtlMs);
      anchorOn(refresh);

      return true;
    },
    since(): Timestamp | undefined {
      return watermark === undefined ? undefined : watermark - WATERMARK_MARGIN;
    },
    handlerNow,
    verdictFor(
      tags: readonly string[],
      softTags: readonly string[],
      writeTime: Timestamp,
    ): TagVerdict {
      return tagVerdict(states, tags, softTags, writeTime, handlerNow() ?? 0);
    },
  };
}

/**
 * Drop the tags whose last event is older than the cutoff and whose expiration is older
 * than it too, the rule the write script prunes the shared copy by — the cutoff being on
 * the server's wall clock, the one the Entry keys expire on (ADR 0003). `expiredAt` at `0`
 * ("never made Expired") is always older than the cutoff, and so are all its Entries.
 *
 * Such a tag can only ever have dropped an Entry written before the cutoff, and no Entry
 * that old is still in the store: every Entry is written with a TTL of at most `maxTtl`.
 * The local copy has no log scores, so the cutoff is taken on `staleAt`, which is never
 * later than the score the shared log holds for the tag.
 */
function prune(states: Map<string, TagState>, cutoff: Timestamp): void {
  for (const [tag, state] of states) {
    if (state.staleAt <= cutoff && state.expiredAt <= cutoff) states.delete(tag);
  }
}
