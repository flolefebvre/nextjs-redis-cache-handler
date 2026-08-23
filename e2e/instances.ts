import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "redis";
import { inject, vi } from "vitest";

import { freeHostPort } from "../tests/redis-container.js";
import { FIXTURE_DIR, recordFileOf, suffix } from "./fixture-build.js";
import { recordedCalls, type RecordedCalls } from "./records.js";

const NEXT_BIN = join(FIXTURE_DIR, "node_modules", ".bin", "next");
const READY_TIMEOUT = 60_000;

/** The two Instances of a Scenario, on one store and one Key prefix. */
export type InstanceName = "A" | "B";

/** What a request returned, with the `data-rendered-at` marker of every cached scope in it. */
export interface Page {
  status: number;
  html: string;
  /** Marker name (`list-page`, `post-body`, …) to the instant that scope rendered. */
  markers: Record<string, string>;
}

/** One Scenario's Instance pair, their Recorded calls, and the ways to drive them. */
export interface Instances {
  /** The build id every cache key of this build starts with. */
  buildId: string;
  /** The Key prefix these two Instances share, and no other Scenario uses. */
  keyPrefix: string;
  /** The Recorded calls of both Instances, sliced by offset. */
  calls: RecordedCalls;
  /** Request a path from one Instance. */
  get(instance: InstanceName, path: string, headers?: Record<string, string>): Promise<Page>;
  /** Run a Server Action on one Instance, by the name the Fixture exports it under. */
  action(instance: InstanceName, exportedName: string): Promise<number>;
  /** Stop both Instances. */
  stop(): Promise<void>;
}

/**
 * Start one Scenario's Instances: a fresh Key prefix seeded with what `next build` wrote,
 * and a fresh pair of Instances on random ports serving the one build of the run.
 *
 * This is the whole wiring a Scenario file needs — a second one is this call and nothing
 * else — and the only place that talks to Redis: a Scenario asserts on HTTP output and on
 * Recorded calls, never on keys.
 *
 * The prefix is seeded rather than shared: the build's Entries are copied under the
 * Scenario's own prefix, so a prewarmed read is unambiguous (nobody else wrote it) and two
 * Scenario files can never see each other's revalidations. An empty copy is a failure
 * here, where it names itself, rather than a puzzling miss inside a step.
 */
export async function startInstances(scenario: string): Promise<Instances> {
  const build = inject("e2eBuild");
  const keyPrefix = `e2e-${scenario}-${suffix()}:`;
  await seedPrefix(build.redisUrl, build.buildPrefix, keyPrefix);

  const recordFile = recordFileOf(scenario);
  await writeFile(recordFile, "");
  const running = {
    A: await startInstance("A", scenario, build.redisUrl, keyPrefix, recordFile),
    B: await startInstance("B", scenario, build.redisUrl, keyPrefix, recordFile),
  };
  const urlOf = (instance: InstanceName): string => running[instance].url;

  return {
    buildId: build.buildId,
    keyPrefix,
    calls: recordedCalls(recordFile),
    get: async (instance, path, headers) => pageOf(await fetch(urlOf(instance) + path, { headers })),
    action: async (instance, exportedName) => {
      const response = await fetch(urlOf(instance) + "/", {
        method: "POST",
        headers: {
          "Next-Action": await actionId(exportedName),
          "Content-Type": "text/plain;charset=UTF-8",
          Accept: "text/x-component",
        },
        body: "[]",
      });
      await response.text();

      return response.status;
    },
    stop: async () => {
      await Promise.all([running.A.stop(), running.B.stop()]);
    },
  };
}

interface RunningInstance {
  url: string;
  stop(): Promise<void>;
}

async function startInstance(
  name: InstanceName,
  scenario: string,
  redisUrl: string,
  keyPrefix: string,
  recordFile: string,
): Promise<RunningInstance> {
  const port = await freeHostPort();
  const url = `http://127.0.0.1:${String(port)}`;
  const child = spawn(NEXT_BIN, ["start", "-p", String(port)], {
    cwd: FIXTURE_DIR,
    env: {
      ...process.env,
      REDIS_URL: redisUrl,
      NEXT_REDIS_CACHE_KEY_PREFIX: keyPrefix,
      NEXT_CACHE_E2E_RECORD_FILE: recordFile,
      NEXT_CACHE_E2E_INSTANCE: name,
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = createWriteStream(join(FIXTURE_DIR, ".e2e", `${scenario}-${name}.log`));
  child.stdout.pipe(log);
  child.stderr.pipe(log);

  await waitUntilServing(url, child);

  return { url, stop: () => stopInstance(child) };
}

async function waitUntilServing(url: string, child: ChildProcess): Promise<void> {
  await vi.waitUntil(
    async () => {
      if (child.exitCode !== null) throw new Error(`the Instance exited with ${String(child.exitCode)}`);

      return fetch(`${url}/api/revalidate`).then(
        (response) => response.ok,
        () => false,
      );
    },
    { timeout: READY_TIMEOUT, interval: 100 },
  );
}

function stopInstance(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Copy every key `next build` wrote under its own prefix to the Scenario's. The Key prefix
 * is a verbatim string prefix on every key this library writes, so one `SCAN` pattern and
 * one `COPY` per key is the whole operation, and it needs to know nothing of the key
 * layout. `COPY` is Redis 6.2 and Valkey 7.2, the floor this library supports.
 */
async function seedPrefix(redisUrl: string, from: string, to: string): Promise<void> {
  const client = createClient({ url: redisUrl });
  await client.connect();
  let copied = 0;
  try {
    for await (const keys of client.scanIterator({ MATCH: `${from}*`, COUNT: 500 })) {
      for (const key of keys) {
        await client.copy(key, `${to}${key.slice(from.length)}`);
        copied += 1;
      }
    }
  } finally {
    await client.close();
  }

  if (copied === 0) {
    throw new Error(`\`next build\` wrote nothing under \`${from}\`: there is no prewarm to seed`);
  }
}

async function actionId(exportedName: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(FIXTURE_DIR, ".next", "server", "server-reference-manifest.json"), "utf-8"),
  ) as { node: Record<string, { exportedName?: string }> };
  const found = Object.entries(manifest.node).find(
    ([, reference]) => reference.exportedName === exportedName,
  );
  if (found === undefined) {
    throw new Error(`the Fixture app exports no Server Action named \`${exportedName}\``);
  }

  return found[0];
}

async function pageOf(response: Response): Promise<Page> {
  const html = await response.text();

  return { status: response.status, html, markers: markersOf(html) };
}

function markersOf(html: string): Record<string, string> {
  const markers: Record<string, string> = {};
  for (const [, name, value] of html.matchAll(/data-rendered-at="([^"]+)">([^<]*)</g)) {
    if (name !== undefined && value !== undefined) markers[name] = value;
  }

  return markers;
}
