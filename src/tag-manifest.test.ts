import { expect, test } from "vitest";

import {
  createTagManifest,
  encodeTagDurations,
  parseTagRefresh,
  tagVerdict,
  type TagState,
} from "./tag-manifest.js";

const NOW = 1787325433671;
const MAX_TTL_MS = 2_592_000_000;

function states(entries: Record<string, TagState>): Map<string, TagState> {
  return new Map(Object.entries(entries));
}

test("a manifest value is the two instants the tag was last made Stale and Expired", () => {
  const refresh = parseTagRefresh(["10", ["posts", "10:20", "post:1", "30:30"]]);

  expect(refresh.serverNow).toBe(10);
  expect(refresh.states).toEqual(
    states({ posts: { staleAt: 10, expiredAt: 20 }, "post:1": { staleAt: 30, expiredAt: 30 } }),
  );
});

test("a manifest value that is not two numbers is dropped, the rest is kept", () => {
  const fields = ["ok", "1:2", "missing", "1", "empty", "", "words", "a:b", "extra", "1:2:3"];

  expect(parseTagRefresh(["1", fields]).states).toEqual(
    states({ ok: { staleAt: 1, expiredAt: 2 } }),
  );
});

test("an empty manifest reads as an empty local copy", () => {
  expect(parseTagRefresh(["1", []])).toEqual({ serverNow: 1, states: new Map() });
});

test("a reply that is not a manifest is not decoded into an empty manifest", () => {
  expect(() => parseTagRefresh(undefined)).toThrow();
  expect(() => parseTagRefresh(["1"])).toThrow();
  expect(() => parseTagRefresh(["now", []])).toThrow();
  expect(() => parseTagRefresh(["1", ["odd"]])).toThrow();
});

test("no durations expires the tags now", () => {
  expect(encodeTagDurations(undefined)).toEqual({ mode: "expire-now", expireMs: 0 });
});

test("an expire duration expires the tags that many seconds from now", () => {
  expect(encodeTagDurations({ expire: 31536000 })).toEqual({
    mode: "expire-after",
    expireMs: 31536000000,
  });
  expect(encodeTagDurations({ expire: 0 })).toEqual({ mode: "expire-after", expireMs: 0 });
});

test("durations without an expire leave the tags' expiration where it was", () => {
  expect(encodeTagDurations({})).toEqual({ mode: "expire-unchanged", expireMs: 0 });
  expect(encodeTagDurations({ expire: undefined })).toEqual({
    mode: "expire-unchanged",
    expireMs: 0,
  });
});

test("an expire that is not a finite number of seconds is the never sentinel", () => {
  expect(encodeTagDurations({ expire: Infinity })).toEqual({
    mode: "expire-after",
    expireMs: 4294967294000,
  });
  expect(encodeTagDurations({ expire: Number.NaN })).toEqual({
    mode: "expire-after",
    expireMs: 4294967294000,
  });
});

test("an Entry no tag of which was ever touched is fresh", () => {
  expect(tagVerdict(states({}), ["posts"], ["_N_T_/layout"], NOW, NOW + 1)).toBe("fresh");
  expect(
    tagVerdict(states({ other: { staleAt: NOW, expiredAt: NOW } }), ["posts"], [], NOW, NOW),
  ).toBe("fresh");
});

test("an Entry with no tags at all is fresh", () => {
  expect(tagVerdict(states({ posts: { staleAt: NOW, expiredAt: NOW } }), [], [], 1, NOW)).toBe(
    "fresh",
  );
});

test("a tag expired after the Entry was written makes it expired", () => {
  const manifest = states({ posts: { staleAt: NOW, expiredAt: NOW } });

  expect(tagVerdict(manifest, ["posts"], [], NOW - 1, NOW)).toBe("expired");
});

test("a tag expired before the Entry was written leaves it fresh", () => {
  const manifest = states({ posts: { staleAt: NOW, expiredAt: NOW } });

  expect(tagVerdict(manifest, ["posts"], [], NOW, NOW)).toBe("fresh");
  expect(tagVerdict(manifest, ["posts"], [], NOW + 1, NOW)).toBe("fresh");
});

test("a tag whose expiration is still in the future does not expire the Entry yet", () => {
  const manifest = states({ posts: { staleAt: NOW - 10, expiredAt: NOW + 1 } });

  expect(tagVerdict(manifest, ["posts"], [], NOW - 20, NOW)).toBe("stale");
});

test("a tag that was never made Expired only ever makes an Entry Stale", () => {
  const manifest = states({ posts: { staleAt: NOW, expiredAt: 0 } });

  expect(manifest.get("posts")?.expiredAt).toBe(0);
  expect(tagVerdict(manifest, ["posts"], [], NOW + 1, NOW)).toBe("fresh");
  expect(tagVerdict(manifest, ["posts"], [], NOW - 1, NOW)).toBe("stale");
});

test("a tag made Stale after the Entry was written makes it Stale", () => {
  const manifest = states({ posts: { staleAt: NOW, expiredAt: NOW + 1000 } });

  expect(tagVerdict(manifest, ["posts"], [], NOW - 1, NOW)).toBe("stale");
  expect(tagVerdict(manifest, ["posts"], [], NOW, NOW)).toBe("fresh");
});

test("an expired tag wins over a Stale one, whichever order they come in", () => {
  const manifest = states({
    stale: { staleAt: NOW, expiredAt: NOW + 1000 },
    gone: { staleAt: NOW, expiredAt: NOW },
  });

  expect(tagVerdict(manifest, ["stale", "gone"], [], NOW - 1, NOW)).toBe("expired");
  expect(tagVerdict(manifest, ["gone", "stale"], [], NOW - 1, NOW)).toBe("expired");
});

test("a Soft tag is compared exactly like an Explicit one", () => {
  const manifest = states({ "_N_T_/blog": { staleAt: NOW, expiredAt: NOW } });

  expect(tagVerdict(manifest, [], ["_N_T_/blog"], NOW - 1, NOW)).toBe("expired");
  expect(tagVerdict(manifest, [], ["_N_T_/blog"], NOW + 1, NOW)).toBe("fresh");
});

test("a local copy answers nothing until a refresh has landed", () => {
  const manifest = createTagManifest(MAX_TTL_MS);

  expect(manifest.serverNow()).toBeUndefined();
});

test("a refresh replaces the local copy wholesale", () => {
  const manifest = createTagManifest(MAX_TTL_MS);

  manifest.replaceWith({
    serverNow: NOW,
    states: states({ posts: { staleAt: NOW, expiredAt: NOW } }),
  });
  manifest.replaceWith({
    serverNow: NOW + 5,
    states: states({ other: { staleAt: 1, expiredAt: 2 } }),
  });

  expect(manifest.verdictFor(["posts"], [], NOW - 1)).toBe("fresh");
  expect(manifest.verdictFor(["other"], [], 1)).toBe("expired");
});

test("the server clock the local copy answers on moves forward from the last refresh", () => {
  const manifest = createTagManifest(MAX_TTL_MS);

  manifest.replaceWith({ serverNow: NOW, states: states({}) });

  expect(manifest.serverNow()).toBeGreaterThanOrEqual(NOW);
  expect(manifest.serverNow()).toBeLessThan(NOW + 60_000);
});

test("a local copy no refresh has landed in has no watermark to read from", () => {
  const manifest = createTagManifest(MAX_TTL_MS);

  expect(manifest.since()).toBeUndefined();
  expect(
    manifest.mergeWith({ serverNow: NOW, states: states({ posts: { staleAt: 1, expiredAt: 2 } }) }),
  ).toBe(false);
  expect(manifest.serverNow()).toBeUndefined();
});

test("the next watermark read starts a second before the last refresh", () => {
  const manifest = createTagManifest(MAX_TTL_MS);

  manifest.replaceWith({ serverNow: NOW, states: states({}) });

  expect(manifest.since()).toBe(NOW - 1000);
});

test("a merge overwrites the tags it brings back and leaves the others alone", () => {
  const manifest = createTagManifest(MAX_TTL_MS);

  manifest.replaceWith({
    serverNow: NOW,
    states: states({
      posts: { staleAt: NOW, expiredAt: 0 },
      other: { staleAt: NOW, expiredAt: 0 },
    }),
  });
  const merged = manifest.mergeWith({
    serverNow: NOW + 5,
    states: states({ posts: { staleAt: NOW + 5, expiredAt: NOW + 5 } }),
  });

  expect(merged).toBe(true);
  expect(manifest.verdictFor(["posts"], [], NOW + 4)).toBe("expired");
  expect(manifest.verdictFor(["other"], [], NOW - 1)).toBe("stale");
  expect(manifest.since()).toBe(NOW + 5 - 1000);
});

test("a refresh whose clock is behind the watermark is refused and changes nothing", () => {
  const manifest = createTagManifest(MAX_TTL_MS);

  manifest.replaceWith({
    serverNow: NOW,
    states: states({ posts: { staleAt: NOW, expiredAt: NOW } }),
  });
  const merged = manifest.mergeWith({
    serverNow: NOW - 1,
    states: states({ posts: { staleAt: 1, expiredAt: 1 } }),
  });

  expect(merged).toBe(false);
  expect(manifest.verdictFor(["posts"], [], NOW - 1)).toBe("expired");
  expect(manifest.since()).toBe(NOW - 1000);
});

test("a merge drops the tags no living Entry can be affected by any more", () => {
  const manifest = createTagManifest(MAX_TTL_MS);

  manifest.replaceWith({
    serverNow: NOW,
    states: states({
      old: { staleAt: NOW - MAX_TTL_MS - 1, expiredAt: NOW - MAX_TTL_MS - 1 },
      never: { staleAt: NOW - MAX_TTL_MS - 1, expiredAt: 0 },
    }),
  });
  manifest.mergeWith({ serverNow: NOW, states: states({}) });

  expect(manifest.verdictFor(["old"], [], NOW - MAX_TTL_MS - 2)).toBe("fresh");
  expect(manifest.verdictFor(["never"], [], NOW - MAX_TTL_MS - 2)).toBe("fresh");
});

test("a merge keeps a tag whose expiration has not fallen behind maxTtl yet", () => {
  const manifest = createTagManifest(MAX_TTL_MS);

  manifest.replaceWith({
    serverNow: NOW,
    states: states({ posts: { staleAt: NOW - MAX_TTL_MS - 1, expiredAt: NOW } }),
  });
  manifest.mergeWith({ serverNow: NOW, states: states({}) });

  expect(manifest.verdictFor(["posts"], [], NOW - MAX_TTL_MS - 2)).toBe("expired");
});

test("the server clock the local copy answers on moves on with a merge too", () => {
  const manifest = createTagManifest(MAX_TTL_MS);

  manifest.replaceWith({ serverNow: NOW, states: states({}) });
  manifest.mergeWith({ serverNow: NOW + 60_000, states: states({}) });

  expect(manifest.serverNow()).toBeGreaterThanOrEqual(NOW + 60_000);
});
