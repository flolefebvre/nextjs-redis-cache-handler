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

/**
 * Which Handler slot module a build of the Fixture registers: the recording wrapper, or
 * the library's Zero-config entry with no wrapper in the path. `next.config.ts` reads it
 * from `NEXT_CACHE_E2E_HANDLER`, and derives both the Handler slot modules and the
 * `distDir` from it, so the two builds coexist and `next start` serves the one its
 * Instances were started for.
 */
export type FixtureHandler = "recording" | "zero-config";

/** One build of the run, and what a Scenario's Instances need to serve it. */
export interface FixtureBuild {
  /** The Handler slot module this build registered, which its Instances select too. */
  handler: FixtureHandler;
  /** The build id every cache key of this build starts with. */
  buildId: string;
  /**
   * The Key prefix the build workers wrote their Entries under, which every Scenario on
   * this build is seeded from — absent for a build that ran with no store and wrote none.
   */
  buildPrefix?: string;
  /**
   * The JSONL file the build workers recorded into — absent for a build with no recording
   * wrapper in the path, which records nothing.
   */
  recordFile?: string;
}

/** The builds of one run, and the store they and every Instance of the run share. */
export interface FixtureBuilds {
  /** The store every Instance of the run shares. */
  redisUrl: string;
  /** The build the Fixture's recording wrapper is registered in: what most Scenarios serve. */
  recording: FixtureBuild;
  /** The build the library's Zero-config entry is registered in, made with no store at all. */
  zeroConfig: FixtureBuild;
}

/** The record file one Scenario's Instances append to. */
export function recordFileOf(scenario: string): string {
  return join(RECORD_DIR, `${scenario}.jsonl`);
}

/** Where a build's output lands: the same value `next.config.ts` derives from the selector. */
export function distDirOf(handler: FixtureHandler): string {
  return handler === "zero-config" ? ".next-zero-config" : ".next";
}

/**
 * The environment a Fixture process runs in: the harness's variables over the developer's,
 * and no inherited `REDIS_URL` when the caller passed none. A process that is meant to
 * have no store must not find one in the shell that started the run — that is the whole
 * observation of the Scenario that starts one.
 */
export function fixtureEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const merged = { ...process.env, ...env };
  if (!("REDIS_URL" in env)) delete merged.REDIS_URL;

  return merged;
}

/**
 * Build the Fixture app for the run: once with the recording wrapper and the store
 * reachable, so that the build workers write their Entries into it — the prewarm every
 * Scenario on that build then reads back — and once with the library's Zero-config entry
 * and no store at all, which is the case a build box without Redis is in and must survive.
 *
 * The two builds land in `distDir`s of their own, so neither clobbers the other and a
 * Scenario serves whichever one it asked for, for the whole run.
 *
 * The Fixture consumes the library the way a published consumer does — by package name,
 * through the `exports` map — so `dist/` has to be there. It is the gate's `build` step
 * that puts it there, before `test:e2e`; a run started without one fails here rather than
 * inside a Scenario, where a missing module would read as a broken app.
 */
export async function buildFixtures(redisUrl: string): Promise<FixtureBuilds> {
  await assertBuiltLibrary();
  await rm(RECORD_DIR, { recursive: true, force: true });
  await mkdir(RECORD_DIR, { recursive: true });

  const buildPrefix = `e2e-build-${suffix()}:`;
  const recordFile = join(RECORD_DIR, "build.jsonl");

  return {
    redisUrl,
    recording: {
      handler: "recording",
      buildPrefix,
      recordFile,
      buildId: await build("recording", {
        REDIS_URL: redisUrl,
        NEXT_REDIS_CACHE_KEY_PREFIX: buildPrefix,
        NEXT_CACHE_E2E_RECORD_FILE: recordFile,
        NEXT_CACHE_E2E_INSTANCE: "build",
      }),
    },
    zeroConfig: { handler: "zero-config", buildId: await build("zero-config", {}) },
  };
}

/** A suffix no other run of this suite uses, for the prefixes one run mints. */
export function suffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function build(handler: FixtureHandler, env: Record<string, string>): Promise<string> {
  try {
    await run(NEXT_BIN, ["build"], {
      cwd: FIXTURE_DIR,
      env: fixtureEnv({ ...env, NEXT_CACHE_E2E_HANDLER: handler, NEXT_TELEMETRY_DISABLED: "1" }),
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`the Fixture app failed to build (${handler}):\n${outputOf(error)}`);
  }

  return (await readFile(join(FIXTURE_DIR, distDirOf(handler), "BUILD_ID"), "utf-8")).trim();
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
