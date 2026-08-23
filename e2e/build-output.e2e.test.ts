import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, inject, test } from "vitest";

import { EDGE_UNSUPPORTED } from "../src/disabled-handler.js";
import { distDirOf, FIXTURE_DIR } from "./fixture-build.js";

const EDGE_OUTPUT = join(FIXTURE_DIR, distDirOf("recording"), "server", "edge");
const NODE_ONLY = "node:net";

test("the Edge bundle of the Fixture carries the Edge target, and nothing of the Node.js one", async () => {
  const chunks = await edgeChunks();

  expect(chunks.some((chunk) => chunk.includes(EDGE_UNSUPPORTED))).toBe(true);
  expect(chunks.filter((chunk) => chunk.includes(NODE_ONLY))).toEqual([]);
});

test("the build wrote its Entries into the store the Instances read", async () => {
  const recorded = await readFile(recordFileOfBuild(), "utf-8");

  expect(recorded).toContain(`"method":"set"`);
});

function recordFileOfBuild(): string {
  const { recordFile } = inject("e2eBuilds").recording;
  if (recordFile === undefined) throw new Error("the recording build recorded into no file");

  return recordFile;
}

async function edgeChunks(): Promise<string[]> {
  const entries = await readdir(EDGE_OUTPUT, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".js"));
  expect(files.length).toBeGreaterThan(0);

  return Promise.all(files.map((file) => readFile(join(file.parentPath, file.name), "utf-8")));
}
