import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, normalize } from "node:path";

const ALLOWED = /^(dist\/|src\/|README\.md$|LICENSE$|package\.json$)/;
const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/index.js.map",
  "dist/index.d.ts.map",
  "dist/handler.js",
  "dist/handler.d.ts",
  "dist/handler.node.js",
  "dist/handler.node.d.ts",
  "dist/handler.edge.js",
  "dist/handler.edge.d.ts",
  "dist/index.edge.js",
  "dist/index.edge.d.ts",
];
const EDGE_TARGETS = ["dist/handler.edge.js", "dist/index.edge.js"];
const BUILTINS = new Set(builtinModules);
const SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;
const NEXT_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'](next(?:\/[^"']*)?)["']/;

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf-8" }),
) as [{ files: { path: string }[] }];
const paths = packed[0].files.map((file) => file.path).sort();

const stray = paths.filter((path) => !ALLOWED.test(path));
if (stray.length > 0) {
  fail(`Unexpected files in the tarball: ${stray.join(", ")}`);
}

const tests = paths.filter((path) => path.endsWith(".test.ts"));
if (tests.length > 0) {
  fail(`Test files in the tarball: ${tests.join(", ")}`);
}

const missing = REQUIRED.filter((required) => !paths.includes(required));
if (missing.length > 0) {
  fail(`Missing from the tarball: ${missing.join(", ")}`);
}

const importsNext = paths.filter((path) => NEXT_IMPORT.test(readFileSync(path, "utf-8")));
if (importsNext.length > 0) {
  fail(`Shipped files import next: ${importsNext.join(", ")}`);
}

/**
 * Every module an Edge target statically pulls in, itself included.
 *
 * Node.js loads a `node:` import happily, so no smoke run under `--conditions=edge-light`
 * can see one: only a walk of the graph the bundler walks catches a `redis` or a `node:`
 * import that crept in one file below an Edge target.
 */
function closureOf(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);

    for (const specifier of specifiersOf(file)) {
      if (!specifier.startsWith(".")) continue;
      pending.push(normalize(join(dirname(file), specifier)));
    }
  }

  return [...seen];
}

function specifiersOf(file: string): string[] {
  const source = readFileSync(file, "utf-8");

  return [...source.matchAll(SPECIFIER)].map((match) => match[1] ?? "");
}

const forbidden = (specifier: string): boolean =>
  specifier === "redis" ||
  specifier.startsWith("@redis/") ||
  specifier.startsWith("node:") ||
  BUILTINS.has(specifier);

for (const target of EDGE_TARGETS) {
  const offenders = closureOf(target).flatMap((file) =>
    specifiersOf(file)
      .filter(forbidden)
      .map((specifier) => `${file} imports ${specifier}`),
  );

  if (offenders.length > 0) {
    fail(`The Edge target ${target} reaches a module no Edge bundle can:\n${offenders.join("\n")}`);
  }
}

console.log(
  `Tarball OK: ${String(paths.length)} files, none importing next, ` +
    `${String(EDGE_TARGETS.length)} Edge targets free of redis and node:`,
);
