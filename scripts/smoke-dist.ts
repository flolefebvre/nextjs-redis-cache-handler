import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CONSUMER = fileURLToPath(new URL("../tests/dist-consumer/", import.meta.url));

/**
 * A store nobody is listening on: the smokes must never depend on what the host happens
 * to be running, and nothing here connects — that is what they check.
 */
const NO_SERVER_THERE = "redis://127.0.0.1:1";
const TIMEOUT_MS = 30_000;

interface Smoke {
  what: string;
  file: string;
  url?: string;
  conditions?: string;
  expected: RegExp | "";
}

const SMOKES: Smoke[] = [
  { what: "ESM import of ./handler", file: "smoke.mjs", url: NO_SERVER_THERE, expected: "" },
  {
    what: "CommonJS require.resolve of ./handler",
    file: "smoke.cjs",
    url: NO_SERVER_THERE,
    expected: "",
  },
  { what: "the entry with no REDIS_URL", file: "smoke.mjs", expected: /^[^\n]*REDIS_URL[^\n]*\n$/ },
  {
    what: "the README's next.config.mjs snippet",
    file: "smoke.next-config.mjs",
    url: NO_SERVER_THERE,
    expected: "",
  },
  {
    what: "both entries under the edge-light condition",
    file: "smoke.edge.mjs",
    url: NO_SERVER_THERE,
    conditions: "edge-light",
    expected: /Edge runtime is not supported/,
  },
];

/** The environment one smoke runs in: this one, with `REDIS_URL` set or taken out. */
function environmentFor(url: string | undefined): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.REDIS_URL;
  if (url !== undefined) environment.REDIS_URL = url;

  return environment;
}

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

for (const smoke of SMOKES) {
  const argv =
    smoke.conditions === undefined
      ? [smoke.file]
      : [`--conditions=${smoke.conditions}`, smoke.file];
  const { status, signal, stderr, stdout } = spawnSync(process.execPath, argv, {
    cwd: CONSUMER,
    encoding: "utf-8",
    timeout: TIMEOUT_MS,
    env: environmentFor(smoke.url),
  });

  if (signal !== null) {
    fail(`${smoke.what}: the process never exited on its own (${signal}), a socket is open`);
  }
  if (status !== 0) fail(`${smoke.what}: exited ${String(status)}\n${stdout}${stderr}`);
  if (smoke.expected === "" ? stderr !== "" : !smoke.expected.test(stderr)) {
    fail(`${smoke.what}: unexpected output on stderr\n${stderr}`);
  }

  console.log(`Smoke OK: ${smoke.what}`);
}
