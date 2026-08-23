import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, inject, test } from "vitest";

import { EDGE_UNSUPPORTED } from "../src/disabled-handler.js";
import { FIXTURE_DIR } from "./fixture-build.js";

const EDGE_OUTPUT = join(FIXTURE_DIR, ".next", "server", "edge");
const NODE_ONLY = "node:net";

test("the Edge bundle of the Fixture carries the Edge target, and nothing of the Node.js one", async () => {
  const chunks = await edgeChunks();

  expect(chunks.some((chunk) => chunk.includes(EDGE_UNSUPPORTED))).toBe(true);
  expect(chunks.filter((chunk) => chunk.includes(NODE_ONLY))).toEqual([]);
});

test("the build wrote its Entries into the store the Instances read", async () => {
  const recorded = await readFile(inject("e2eBuild").recordFile, "utf-8");

  expect(recorded).toContain(`"method":"set"`);
});

async function edgeChunks(): Promise<string[]> {
  const entries = await readdir(EDGE_OUTPUT, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".js"));
  expect(files.length).toBeGreaterThan(0);

  return Promise.all(files.map((file) => readFile(join(file.parentPath, file.name), "utf-8")));
}
