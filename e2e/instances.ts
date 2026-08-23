import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "redis";
import { inject, vi } from "vitest";

import {
  freeHostPort,
  providedRedisUrl,
  startOutageRedis,
  testImage,
  type OutageRedis,
} from "../tests/redis-container.js";
import {
  distDirOf,
  fixtureEnv,
  recordFileOf,
  suffix,
  FIXTURE_DIR,
  type FixtureBuild,
  type FixtureHandler,
} from "./fixture-build.js";
import { recordedCalls, type RecordedCalls } from "./records.js";

const NEXT_BIN = join(FIXTURE_DIR, "node_modules", ".bin", "next");
const READY_TIMEOUT = 60_000;
const MARKER_TIMEOUT = 20_000;

/** The two Instances of a Scenario, on one store and one Key prefix. */
export type InstanceName = "A" | "B";

/** What a request returned, with the `data-rendered-at` marker of every cached scope in it. */
export interface Page {
  status: number;
  html: string;
  /** Marker name (`list-page`, `post-body`, …) to the instant that scope rendered. */
  markers: Record<string, string>;
  /** What the response set as cookies, by name: the Draft Mode bypass cookie among them. */
  cookies: Record<string, string>;
}

/**
 * The `cookie` header carrying back what a response set, for the request that follows.
 * A Scenario that drives Draft Mode reads `/api/draft` and hands this to its next `get`;
 * the harness keeps no cookie of its own, so a step says which response it is carrying.
 */
export function cookieHeader(page: Page): Record<string, string> {
  return {
    cookie: Object.entries(page.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
  };
}

/** What a Scenario changes about its Instances, when the harness's defaults do not fit. */
export interface InstancesOptions {
  /**
   * Which build of the run these Instances serve: the recording one by default, the one
   * the library's Zero-config entry is registered in when a Scenario asks for it. A
   * Zero-config build records nothing — no wrapper is in the path — so its `calls` are
   * empty and a Scenario on it asserts on HTTP output and on what the Instances logged.
   */
  build?: FixtureHandler;
  /**
   * Which store the Instances are given. `shared` is the run's own, which every other
   * Scenario is talking to; `none` starts them with no `REDIS_URL` at all, not even the
   * one the developer's shell may carry; `own` starts a server for this Scenario alone,
   * which it may therefore break — the run's store is never paused nor stopped.
   */
  store?: "shared" | "none" | "own";
  /**
   * Extra environment for both Instances, on top of what the harness sets: the library's
   * own `NEXT_REDIS_CACHE_*` variables, for a Scenario whose narrative is a configuration.
   */
  env?: Record<string, string>;
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
  /**
   * The markers of a path on one Instance, once the named scope has stopped rendering the
   * instant it was rendered at before: a revalidation reaches an Instance when it reads the
   * Tag manifest again, and a Stale one regenerates in the background, neither of which any
   * instant of a Scenario's clock names.
   *
   * Only a 200 that carries the marker ends the wait. A page that failed, or one that
   * rendered the scope away, has a marker of `undefined`, which differs from every instant
   * and would end the wait on an observation nobody made.
   */
  markersOnceChanged(
    instance: InstanceName,
    path: string,
    marker: string,
    before: string | undefined,
  ): Promise<Record<string, string>>;
  /**
   * The markers of a path on one Instance, once two consecutive requests agree on the
   * named scope: what that Instance serves from its Entries rather than from a render.
   *
   * The counterpart of `markersOnceChanged` for a Scenario that has no Recorded call to
   * wait on — a build with no recording wrapper in the path — since the write that follows
   * a first render lands at an instant no clock of a Scenario names.
   */
  markersOnceStable(
    instance: InstanceName,
    path: string,
    marker: string,
  ): Promise<Record<string, string>>;
  /** Run a Server Action on one Instance, by the name the Fixture exports it under. */
  action(instance: InstanceName, exportedName: string): Promise<number>;
  /**
   * The lines an Instance has logged that contain `text`, once at least one of them has.
   * A process writes its log while it runs and no instant of a Scenario's clock names when
   * a line lands, so a Scenario that expects one waits for it here rather than reading a
   * file it opened by a path it guessed.
   */
  logged(instance: InstanceName, text: string): Promise<string[]>;
  /**
   * Stop both Instances, and remove the store when it was this Scenario's own. An outage
   * a failed step left in place is lifted first: removing a frozen container waits the
   * runtime's stop timeout out before it kills it.
   */
  stop(): Promise<void>;
}

/** The store one Scenario alone runs on, and the outage it may put it through. */
export interface OwnStore {
  /** Freeze the server: connections stay open, commands never get a reply. */
  pause(): Promise<void>;
  /** Unfreeze it: the commands that were in flight get their reply. */
  unpause(): Promise<void>;
}

/**
 * The Instances of a Scenario that asked for a store of its own: the only ones that carry
 * a store to break, so that a Scenario on the run's shared store cannot pause it at all.
 */
export interface OwnStoreInstances extends Instances {
  /** The store this Scenario alone runs on, which it may therefore break. */
  store: OwnStore;
}

/**
 * Whether a Scenario that breaks its own store can run at all: it needs a server the
 * harness started, and `CACHE_TEST_REDIS_URL` names one it was only lent — a provided
 * server is nobody's to pause. The e2e counterpart of the skip the outage integration
 * tests take, kept here so that no Scenario reaches for the container harness itself.
 */
export function canPauseStore(): boolean {
  return providedRedisUrl() === undefined;
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
 *
 * A Scenario on a store of its own is seeded from nothing instead: the build's Entries are
 * on the run's server and `COPY` never crosses two of them, so it warms what it needs with
 * its own first requests, exactly as a Scenario on the Zero-config build does.
 */
export function startInstances(
  scenario: string,
  options: InstancesOptions & { store: "own" },
): Promise<OwnStoreInstances>;
export function startInstances(scenario: string, options?: InstancesOptions): Promise<Instances>;
export async function startInstances(
  scenario: string,
  options: InstancesOptions = {},
): Promise<Instances> {
  const builds = inject("e2eBuilds");
  const build = builds[options.build === "zero-config" ? "zeroConfig" : "recording"];
  const keyPrefix = `e2e-${scenario}-${suffix()}:`;
  const own = options.store === "own" ? await startOutageRedis(testImage()) : undefined;
  if (build.buildPrefix !== undefined && own === undefined) {
    await seedPrefix(builds.redisUrl, build.buildPrefix, keyPrefix);
  }

  const recordFile = recordFileOf(scenario);
  const env: InstanceEnv = {
    NEXT_REDIS_CACHE_KEY_PREFIX: keyPrefix,
    NEXT_CACHE_E2E_HANDLER: build.handler,
    NEXT_TELEMETRY_DISABLED: "1",
    ...(options.store === "none" ? {} : { REDIS_URL: own?.url ?? builds.redisUrl }),
    ...(await recording(build, recordFile)),
    ...options.env,
  };
  const running = await instancePair(scenario, env, own);
  const urlOf = (instance: InstanceName): string => running[instance].url;

  const get = async (
    instance: InstanceName,
    path: string,
    headers?: Record<string, string>,
  ): Promise<Page> => pageOf(await fetch(urlOf(instance) + path, { headers }));

  return {
    buildId: build.buildId,
    keyPrefix,
    ...(own === undefined ? {} : { store: { pause: own.pause, unpause: own.unpause } }),
    calls: recordedCalls(recordFile),
    get,
    markersOnceChanged: async (instance, path, marker, before) => {
      if (before === undefined) {
        throw new Error(`the page rendered no \`${marker}\` marker to wait for a change of`);
      }
      let markers: Record<string, string> = {};
      await vi.waitUntil(
        async () => {
          const page = await get(instance, path);
          markers = page.markers;
          const rendered = markers[marker];

          return page.status === 200 && rendered !== undefined && rendered !== before;
        },
        { timeout: MARKER_TIMEOUT, interval: 100 },
      );

      return markers;
    },
    markersOnceStable: async (instance, path, marker) => {
      let markers: Record<string, string> = {};
      let previous: string | undefined;
      await vi.waitUntil(
        async () => {
          const page = await get(instance, path);
          markers = page.markers;
          const rendered = markers[marker];
          const stable = page.status === 200 && rendered !== undefined && rendered === previous;
          previous = rendered;

          return stable;
        },
        { timeout: MARKER_TIMEOUT, interval: 100 },
      );

      return markers;
    },
    logged: (instance, text) => loggedLines(logFile(scenario, instance), text),
    action: async (instance, exportedName) => {
      const response = await fetch(urlOf(instance) + "/", {
        method: "POST",
        headers: {
          "Next-Action": await actionId(exportedName, distDirOf(build.handler)),
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
      await own?.unpause();
      await own?.remove();
    },
  };
}

/**
 * Both Instances, started so that a failure to start either one takes down everything the
 * harness had already started for this Scenario — the first Instance, and the server it
 * may own. A Scenario whose `beforeAll` threw never gets to call `stop`, and a `next
 * start` nobody owns would hold its port and its Redis connection for the rest of the run,
 * as would a container nobody removes.
 */
async function instancePair(
  scenario: string,
  env: InstanceEnv,
  own: OutageRedis | undefined,
): Promise<Record<InstanceName, RunningInstance>> {
  try {
    const a = await startInstance("A", scenario, env);

    return { A: a, B: await second(a, scenario, env) };
  } catch (error) {
    await own?.remove();
    throw error;
  }
}

/**
 * The second Instance, started so that a failure to start it takes the first one down with
 * it. An Instance that never becomes ready stops itself, in `startInstance`, for the same
 * reason.
 */
async function second(
  first: RunningInstance,
  scenario: string,
  env: InstanceEnv,
): Promise<RunningInstance> {
  try {
    return await startInstance("B", scenario, env);
  } catch (error) {
    await first.stop();
    throw error;
  }
}

interface RunningInstance {
  url: string;
  stop(): Promise<void>;
}

/** The environment both Instances of a Scenario are started with, bar their own name. */
type InstanceEnv = Record<string, string>;

async function startInstance(
  name: InstanceName,
  scenario: string,
  env: InstanceEnv,
): Promise<RunningInstance> {
  const port = await freeHostPort();
  const url = `http://127.0.0.1:${String(port)}`;
  const child = spawn(NEXT_BIN, ["start", "-p", String(port)], {
    cwd: FIXTURE_DIR,
    env: fixtureEnv({ ...env, NEXT_CACHE_E2E_INSTANCE: name }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = createWriteStream(logFile(scenario, name));
  child.stdout.pipe(log);
  child.stderr.pipe(log);

  try {
    await waitUntilServing(url, child);
  } catch (error) {
    await stopInstance(child);
    throw error;
  }

  return { url, stop: () => stopInstance(child) };
}

/**
 * The record file variables an Instance of the recording build is started with, and the
 * truncated file behind them. A Zero-config build has no wrapper in the path and records
 * nothing, so it is given neither and no file nobody writes to is created.
 */
async function recording(build: FixtureBuild, recordFile: string): Promise<InstanceEnv> {
  if (build.handler !== "recording") return {};
  await writeFile(recordFile, "");

  return { NEXT_CACHE_E2E_RECORD_FILE: recordFile };
}

function logFile(scenario: string, name: InstanceName): string {
  return join(FIXTURE_DIR, ".e2e", `${scenario}-${name}.log`);
}

async function loggedLines(file: string, text: string): Promise<string[]> {
  let lines: string[] = [];
  await vi.waitUntil(
    async () => {
      lines = (await readFile(file, "utf-8")).split("\n").filter((line) => line.includes(text));

      return lines.length > 0;
    },
    { timeout: MARKER_TIMEOUT, interval: 100 },
  );

  return lines;
}

async function waitUntilServing(url: string, child: ChildProcess): Promise<void> {
  await vi.waitUntil(
    async () => {
      if (child.exitCode !== null)
        throw new Error(`the Instance exited with ${String(child.exitCode)}`);

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

/**
 * The id Next.js minted for a Server Action, read from the manifest of the build these
 * Instances serve. Two builds mint two ids for one export, so the `distDir` a Scenario's
 * build wrote to is the only place this may be read from.
 */
async function actionId(exportedName: string, distDir: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(FIXTURE_DIR, distDir, "server", "server-reference-manifest.json"), "utf-8"),
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

  return { status: response.status, html, markers: markersOf(html), cookies: cookiesOf(response) };
}

function cookiesOf(response: Response): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const header of response.headers.getSetCookie()) {
    const [pair = ""] = header.split(";");
    const separator = pair.indexOf("=");
    if (separator > 0) cookies[pair.slice(0, separator)] = pair.slice(separator + 1);
  }

  return cookies;
}

function markersOf(html: string): Record<string, string> {
  const markers: Record<string, string> = {};
  for (const [, name, value] of html.matchAll(/data-rendered-at="([^"]+)">([^<]*)</g)) {
    if (name !== undefined && value !== undefined) markers[name] = value;
  }

  return markers;
}
