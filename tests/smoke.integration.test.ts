import { createClient } from "redis";
import { expect, inject, test } from "vitest";

test("the harness hands every worker a server that answers PING", async () => {
  const client = createClient({ url: inject("redisUrl") });
  await client.connect();

  try {
    await expect(client.ping()).resolves.toBe("PONG");
  } finally {
    await client.close();
  }
});
