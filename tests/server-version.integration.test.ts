import { createClient } from "redis";
import { expect, inject, test } from "vitest";

import { meetsFloor, serverVersion } from "./redis-container.js";

test("the server of the run is at or above the floor its family declares", async () => {
  const client = createClient({ url: inject("redisUrl") });
  await client.connect();

  try {
    const { family, version, floor } = serverVersion(String(await client.info("server")));

    expect(meetsFloor(version, floor), `${family} ${version} is below the ${floor} floor`).toBe(
      true,
    );
  } finally {
    await client.close();
  }
});
