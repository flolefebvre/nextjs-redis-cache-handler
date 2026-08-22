import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
];
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

console.log(`Tarball OK: ${String(paths.length)} files, none importing next`);
