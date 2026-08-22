import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, inject, test } from "vitest";

const run = promisify(execFile);
const PROBE = new URL("exit-probe.ts", import.meta.url).pathname;

test("a process that used a handler exits once close() resolved", { timeout: 60_000 }, async () => {
  const env = {
    ...process.env,
    CACHE_PROBE_REDIS_URL: inject("redisUrl"),
    CACHE_PROBE_KEY_PREFIX: `cache-test:${randomUUID()}:`,
  };

  const probe = run(process.execPath, ["--import", "tsx", PROBE], { env, timeout: 30_000 });

  await expect(probe).resolves.toMatchObject({ stderr: "" });
});
