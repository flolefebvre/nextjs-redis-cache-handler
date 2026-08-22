import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CONSUMER = fileURLToPath(new URL("../tests/dist-consumer/", import.meta.url));
const A_STORE = "redis://127.0.0.1:6379";
const TIMEOUT_MS = 30_000;

interface Smoke {
  what: string;
  file: string;
  url?: string;
  expected: RegExp | "";
}

const SMOKES: Smoke[] = [
  { what: "ESM import of ./handler", file: "smoke.mjs", url: A_STORE, expected: "" },
  { what: "CommonJS require.resolve of ./handler", file: "smoke.cjs", url: A_STORE, expected: "" },
  { what: "the entry with no REDIS_URL", file: "smoke.mjs", expected: /^[^\n]*REDIS_URL[^\n]*\n$/ },
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
  const { status, signal, stderr, stdout } = spawnSync(process.execPath, [smoke.file], {
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
