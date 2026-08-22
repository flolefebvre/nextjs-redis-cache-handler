import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { handlerPath } from "@flefebvre/nextjs-redis-cache-handler";
import handler from "@flefebvre/nextjs-redis-cache-handler/handler";

const METHODS = ["get", "set", "refreshTags", "getExpiration", "updateTags"];

const resolved = fileURLToPath(
  import.meta.resolve("@flefebvre/nextjs-redis-cache-handler/handler"),
);

assert.equal(typeof handler, "object");
assert.equal(handler.default, undefined);
for (const method of METHODS) assert.equal(typeof handler[method], "function");

assert.ok(isAbsolute(handlerPath));
assert.ok(existsSync(handlerPath));
assert.equal(handlerPath, resolved);

assert.equal(await handler.get("smoke", []), undefined);
