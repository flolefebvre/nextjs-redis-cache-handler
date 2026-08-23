/**
 * `next-config.mjs` is the README's `next.config.mjs` snippet, and this runs it: the `.ts`
 * and CommonJS forms are exercised by the e2e Fixture's own config, this one is not.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

import nextConfig from "./next-config.mjs";

const registered = nextConfig.cacheHandlers.default;

assert.equal(typeof registered, "string");
assert.ok(isAbsolute(registered));
assert.ok(existsSync(registered));
