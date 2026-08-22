import assert from "node:assert/strict";

import { createRedisCacheHandler, handlerPath } from "@flefebvre/nextjs-redis-cache-handler";
import handler from "@flefebvre/nextjs-redis-cache-handler/handler";

const METHODS = ["get", "set", "refreshTags", "getExpiration", "updateTags"];

assert.equal(typeof handler, "object");
assert.equal(handler.default, undefined);
for (const method of METHODS) assert.equal(typeof handler[method], "function");

assert.equal(await handler.get("smoke", []), undefined);
assert.equal(await handler.getExpiration(["posts"]), Infinity);

assert.equal(handlerPath, "");

const SHIM = "./node_modules/@flefebvre/nextjs-redis-cache-handler/dist/handler.js";

const byPath = (await import(new URL(SHIM, import.meta.url).href)).default;

assert.equal(byPath, handler);

const factored = createRedisCacheHandler({ url: "redis://127.0.0.1:1" });
for (const method of METHODS) assert.equal(typeof factored[method], "function");
assert.equal(await factored.get("smoke", []), undefined);
assert.equal(await factored.close(), undefined);
