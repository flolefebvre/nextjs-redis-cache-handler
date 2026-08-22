import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, inject, test } from "vitest";

const run = promisify(execFile);
const PROBE = fileURLToPath(new URL("exit-probe.ts", import.meta.url));

function probing(close: boolean): Promise<{ stderr: string }> {
  const env = {
    ...process.env,
    CACHE_PROBE_REDIS_URL: inject("redisUrl"),
    CACHE_PROBE_KEY_PREFIX: `cache-test:${randomUUID()}:`,
    CACHE_PROBE_CLOSE: close ? "1" : "0",
  };

  return run(process.execPath, ["--import", "tsx", PROBE], { env, timeout: 30_000 });
}

test("a process that used a handler exits once close() resolved", { timeout: 60_000 }, async () => {
  await expect(probing(true)).resolves.toMatchObject({ stderr: "" });
});

test(
  "a process that used a handler exits without close() being called at all",
  { timeout: 60_000 },
  async () => {
    await expect(probing(false)).resolves.toMatchObject({ stderr: "" });
  },
);
