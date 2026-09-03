import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const astGrepPath = fileURLToPath(
  new URL("../../node_modules/.bin/ast-grep", import.meta.url)
);

const result = spawnSync(
  astGrepPath,
  [
    "scan",
    "--rule",
    ".quality/no-explicit-top-types.yml",
    "--json=compact",
    "src",
    "--globs",
    "**/*.{ts,tsx,mts,cts}",
    "--globs",
    "!**/__tests__/fixtures/**",
    "--globs",
    "!**/__snapshots__/**",
    "--globs",
    "!**/*.snap.*",
  ],
  { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
);

if (result.error !== undefined) {
  throw result.error;
}

const matches = JSON.parse(result.stdout);
if (!Array.isArray(matches)) {
  throw new TypeError("ast-grep output was not a result array");
}

for (const match of matches) {
  if (
    typeof match !== "object" ||
    match === null ||
    typeof match.file !== "string" ||
    typeof match.text !== "string" ||
    typeof match.range !== "object" ||
    match.range === null ||
    typeof match.range.start !== "object" ||
    match.range.start === null ||
    typeof match.range.start.line !== "number"
  ) {
    throw new TypeError("ast-grep emitted an invalid result");
  }
  const annotation = /\bany\b/.test(match.text) ? "any" : "unknown";
  console.log(
    `${match.file}:${match.range.start.line + 1}: explicit ${annotation}`
  );
}

console.log(`EXPLICIT_TOP_TYPE_COUNT=${matches.length}`);
if (matches.length > 0 || (result.status !== 0 && result.status !== 1)) {
  process.exitCode = 1;
}
