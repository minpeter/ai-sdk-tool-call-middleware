import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const configPath = fileURLToPath(
  new URL("../../.quality/mehen.toml", import.meta.url)
);
const mehenPath = fileURLToPath(
  new URL("../../node_modules/.bin/mehen", import.meta.url)
);
const limits = new Map([
  ["cyclomatic.max", 22],
  ["cognitive.max", 22],
  ["halstead.difficulty", 80],
  ["loc.ploc", 500],
]);

function parseArguments(arguments_) {
  let sourceDirectory = "src";
  let coveragePath;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--source-dir") {
      sourceDirectory = arguments_[index + 1] ?? "";
      index += 1;
    } else if (argument === "--coverage") {
      coveragePath = arguments_[index + 1] ?? "";
      index += 1;
    } else if (argument.startsWith("--coverage=")) {
      coveragePath = argument.slice("--coverage=".length);
    } else {
      throw new TypeError(`Unknown argument: ${argument}`);
    }
  }
  if (sourceDirectory.length === 0 || coveragePath === "") {
    throw new TypeError("Options requiring a path cannot be empty");
  }
  return { coveragePath, sourceDirectory };
}

function readRows(stdout) {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new TypeError("Mehen output was not a top-offenders array");
  }
  return parsed;
}

function metricValues(row) {
  if (
    typeof row !== "object" ||
    row === null ||
    typeof row.path !== "string" ||
    !Array.isArray(row.metrics)
  ) {
    throw new TypeError("Mehen emitted an invalid result row");
  }
  const values = new Map();
  for (const metric of row.metrics) {
    if (
      typeof metric === "object" &&
      metric !== null &&
      typeof metric.name === "string" &&
      typeof metric.value === "number"
    ) {
      values.set(metric.name, metric.value);
    }
  }
  return { path: row.path, values };
}

function buildCommandArguments(sourceDirectory, coveragePath) {
  const commandArguments = [
    "--config",
    configPath,
    "top-offenders",
    sourceDirectory,
    "--include",
    "**/*.{ts,tsx,mts,cts}",
    "--metric",
    "cyclomatic.max",
    "--metric",
    "cognitive.max",
    "--metric",
    "halstead.difficulty",
    "--metric",
    "loc.ploc",
    "--max-results",
    "100000",
    "--output-format",
    "json",
  ];
  if (sourceDirectory === "src") {
    commandArguments.push(
      "--exclude",
      "**/__tests__/fixtures/**",
      "--exclude",
      "**/__snapshots__/**",
      "--exclude",
      "**/*.snap.*"
    );
  }
  if (coveragePath !== undefined) {
    commandArguments.push(
      "--metric",
      "coverage.line",
      `--coverage=${coveragePath}`
    );
  }

  return commandArguments;
}

function findViolations(rows) {
  const violations = [];
  let coveredFiles = 0;
  for (const row of rows) {
    const { path, values } = metricValues(row);
    for (const [metric, limit] of limits) {
      const value = values.get(metric);
      if (value !== undefined && value >= limit) {
        violations.push(`${path}: ${metric}=${value} (required < ${limit})`);
      }
    }
    const coveragePercent = values.get("coverage.line");
    const complexity = values.get("cyclomatic.max");
    if (coveragePercent !== undefined && complexity !== undefined) {
      coveredFiles += 1;
      const uncovered = 1 - coveragePercent / 100;
      const crap = complexity ** 2 * uncovered ** 3 + complexity;
      if (crap >= 25) {
        violations.push(`${path}: CRAP=${crap.toFixed(2)} (required < 25)`);
      }
    }
  }

  return { coveredFiles, violations };
}

function main() {
  const { coveragePath, sourceDirectory } = parseArguments(
    process.argv.slice(2)
  );
  const result = spawnSync(
    mehenPath,
    buildCommandArguments(sourceDirectory, coveragePath),
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  if (result.error !== undefined) {
    throw result.error;
  }

  let rows;
  try {
    rows = readRows(result.stdout);
  } catch (error) {
    process.stderr.write(result.stderr);
    throw error;
  }

  const { coveredFiles, violations } = findViolations(rows);
  console.log(`QUALITY_FILES_ANALYZED=${rows.length}`);
  console.log(
    coveragePath === undefined
      ? "CRAP_UNAVAILABLE (pass --coverage <lcov-path>)"
      : `CRAP_FILES_ANALYZED=${coveredFiles}`
  );
  for (const violation of violations) {
    console.log(violation);
  }
  if (result.status !== 0 && violations.length === 0) {
    process.stderr.write(result.stderr);
    console.log("QUALITY_THRESHOLDS_FAIL");
    process.exitCode = 1;
    return;
  }
  if (violations.length > 0) {
    console.log("QUALITY_THRESHOLDS_FAIL");
    process.exitCode = 1;
    return;
  }
  console.log("QUALITY_THRESHOLDS_PASS");
}

main();
