import { createHash } from "node:crypto";

import { expect, test } from "vitest";

import { tagCommandNames } from "./handler-harness.js";

const PREFIX = "cache-test:harness:";

const MANIFEST = `${PREFIX}{tags}`;

const SCRIPT = "return redis.call('HGETALL', KEYS[1])";

const OTHER_SCRIPT = "return 1";

const MULTILINE_SCRIPT = "local tags = KEYS[1]\nreturn redis.call('HGETALL', tags)\n";

const MULTILINE_DIGEST = createHash("sha1").update(MULTILINE_SCRIPT).digest("hex");

const DIGEST = createHash("sha1").update(SCRIPT).digest("hex");

test("only the commands carrying the tag slot are named, uppercased", () => {
  const commands = [
    ["hgetall", MANIFEST],
    ["get", `${PREFIX}entry:posts`],
    ["zrange", `${MANIFEST}:log`, "0", "+inf"],
  ];

  expect(tagCommandNames(commands, PREFIX)).toEqual(["HGETALL", "ZRANGE"]);
});

test("a script the server did not know is the one run its digest stands for", () => {
  const commands = [
    ["EVALSHA", DIGEST, "1", MANIFEST],
    ["EVAL", SCRIPT, "1", MANIFEST],
    ["HGETALL", MANIFEST],
  ];

  expect(tagCommandNames(commands, PREFIX)).toEqual(["EVALSHA", "HGETALL"]);
});

test("a fallback whose source the stream escaped is still the run its digest names", () => {
  const commands = [
    ["EVALSHA", MULTILINE_DIGEST, "1", MANIFEST],
    ["EVAL", MULTILINE_SCRIPT.replaceAll("\n", "\\n"), "1", MANIFEST],
  ];

  expect(tagCommandNames(commands, PREFIX)).toEqual(["EVALSHA"]);
});

test("another worker's command between the two halves of the fallback does not break it", () => {
  const commands = [
    ["EVALSHA", DIGEST, "1", MANIFEST],
    ["HGETALL", "cache-test:elsewhere:{tags}"],
    ["EVAL", SCRIPT, "1", MANIFEST],
  ];

  expect(tagCommandNames(commands, PREFIX)).toEqual(["EVALSHA"]);
});

test("an EVAL of another script is a run of its own", () => {
  const commands = [
    ["EVALSHA", DIGEST, "1", MANIFEST],
    ["EVAL", OTHER_SCRIPT, "1", MANIFEST],
  ];

  expect(tagCommandNames(commands, PREFIX)).toEqual(["EVALSHA", "EVAL"]);
});

test("an EVAL no digest was sent for is a run of its own", () => {
  const commands = [["EVAL", SCRIPT, "1", MANIFEST]];

  expect(tagCommandNames(commands, PREFIX)).toEqual(["EVAL"]);
});
