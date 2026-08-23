import { mkdtemp, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { outcomesOf, recordedCalls, type RecordedCall } from "./records.js";

test("a step reads only what was appended after the offset it took", async () => {
  const file = await recordFile();
  const calls = recordedCalls(file);
  await append(file, { instance: "A", method: "get", outcome: "hit" });

  const offset = await calls.end();
  await append(file, { instance: "B", method: "get", outcome: "miss:expired" });

  expect(await calls.since(offset)).toMatchObject([{ instance: "B", outcome: "miss:expired" }]);
});

test("a step waits for a call the Instance makes in the background", async () => {
  const file = await recordFile();
  const calls = recordedCalls(file);
  const offset = await calls.end();

  setTimeout(() => void append(file, { instance: "B", method: "set", outcome: "set" }), 50);
  const appended = await calls.waitFor(offset, (call) => call.method === "set");

  expect(outcomesOf(appended, "B")).toEqual(new Set(["set set"]));
});

test("a file no Instance has written to yet reads as no call at all", async () => {
  const calls = recordedCalls(join(await mkdtemp(join(tmpdir(), "e2e-records-")), "absent.jsonl"));

  expect(await calls.since(0)).toEqual([]);
});

async function recordFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "e2e-records-")), "calls.jsonl");
}

async function append(file: string, call: Partial<RecordedCall>): Promise<void> {
  const line = { seq: 1, at: Date.now(), key: "k", tags: [], ...call };

  await appendFile(file, `${JSON.stringify(line)}\n`);
}
