const assert = require("node:assert/strict");

const METHODS = ["get", "set", "refreshTags", "getExpiration", "updateTags"];

const required = require.resolve("@flefebvre/nextjs-redis-cache-handler/handler");

async function smoke() {
  const { handlerPath } = await import("@flefebvre/nextjs-redis-cache-handler");
  const handler = (await import("@flefebvre/nextjs-redis-cache-handler/handler")).default;

  assert.equal(typeof handler, "object");
  assert.equal(handler.default, undefined);
  for (const method of METHODS) assert.equal(typeof handler[method], "function");

  assert.equal(required, handlerPath);

  assert.equal(await handler.get("smoke", []), undefined);
}

smoke().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
