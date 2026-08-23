import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where the Fixture app lives, and where its build output and record files land. */
export const FIXTURE_DIR = fileURLToPath(new URL("./fixture/", import.meta.url));
const RECORD_DIR = join(FIXTURE_DIR, ".e2e");
const NEXT_BIN = join(FIXTURE_DIR, "node_modules", ".bin", "next");
const BUILT_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** The one `next build` of the run, and what a Scenario needs from it. */
export interface FixtureBuild {
  /** The store every Instance of the run shares. */
  redisUrl: string;
  /** The Key prefix the build wrote its Entries under, which every Scenario is seeded from. */
  buildPrefix: string;
  /** The build id every cache key of this build starts with. */
  buildId: string;
  /** The JSONL file the build workers recorded into. */
  recordFile: string;
}

/** The record file one Scenario's Instances append to. */
export function recordFileOf(scenario: string): string {
  return join(RECORD_DIR, `${scenario}.jsonl`);
}

/**
 * Build the Fixture app once for the run, with the store reachable so that the build
 * workers write their Entries into it: the prewarm every Instance then reads back.
 *
 * The Fixture consumes the library the way a published consumer does — by package name,
 * through the `exports` map — so `dist/` has to be there. It is the gate's `build` step
 * that puts it there, before `test:e2e`; a run started without one fails here rather than
 * inside a Scenario, where a missing module would read as a broken app.
 */
export async function buildFixture(redisUrl: string): Promise<FixtureBuild> {
  await assertBuiltLibrary();
  await rm(RECORD_DIR, { recursive: true, force: true });
  await mkdir(RECORD_DIR, { recursive: true });

  const buildPrefix = `e2e-build-${suffix()}:`;
  const recordFile = join(RECORD_DIR, "build.jsonl");
  try {
    await run(NEXT_BIN, ["build"], {
      cwd: FIXTURE_DIR,
      env: {
        ...process.env,
        REDIS_URL: redisUrl,
        NEXT_REDIS_CACHE_KEY_PREFIX: buildPrefix,
        NEXT_CACHE_E2E_RECORD_FILE: recordFile,
        NEXT_CACHE_E2E_INSTANCE: "build",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`the Fixture app failed to build:\n${outputOf(error)}`);
  }

  const buildId = (await readFile(join(FIXTURE_DIR, ".next", "BUILD_ID"), "utf-8")).trim();

  return { redisUrl, buildPrefix, buildId, recordFile };
}

/** A suffix no other run of this suite uses, for the prefixes one run mints. */
export function suffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function assertBuiltLibrary(): Promise<void> {
  try {
    await readFile(BUILT_ENTRY);
  } catch {
    throw new Error(
      "the e2e project needs the built output the Fixture imports: run `pnpm build` first",
    );
  }
}

function outputOf(error: unknown): string {
  const failed = error as { stdout?: string; stderr?: string };

  return `${failed.stdout ?? ""}${failed.stderr ?? ""}` || String(error);
}
