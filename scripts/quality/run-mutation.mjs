import { readdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Stryker } from "@stryker-mutator/core";

const SHARD_COUNT = 24;
const TYPESCRIPT_FILE = /\.(?:cts|mts|tsx?)$/;
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const reportsDirectory = join(repositoryRoot, "reports", "mutation");

function collectProductionFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") {
        files.push(...collectProductionFiles(absolutePath));
      }
    } else if (TYPESCRIPT_FILE.test(entry.name)) {
      files.push(relative(repositoryRoot, absolutePath).split(sep).join("/"));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function requestedShards(rawArguments) {
  const arguments_ =
    rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
  if (arguments_.length === 0) {
    return Array.from({ length: SHARD_COUNT }, (_, index) => index + 1);
  }
  if (arguments_.length !== 2 || arguments_[0] !== "--shard") {
    throw new TypeError("Usage: pnpm mutation -- [--shard N]");
  }
  const shard = Number(arguments_[1]);
  if (!Number.isInteger(shard) || shard < 1 || shard > SHARD_COUNT) {
    throw new RangeError(
      `Shard must be an integer from 1 through ${SHARD_COUNT}`
    );
  }
  return [shard];
}

function countStatuses(results) {
  const counts = { killed: 0, noCoverage: 0, survived: 0, timeout: 0 };
  for (const result of results) {
    switch (result.status) {
      case "Killed":
        counts.killed += 1;
        break;
      case "NoCoverage":
        counts.noCoverage += 1;
        break;
      case "Survived":
        counts.survived += 1;
        break;
      case "Timeout":
        counts.timeout += 1;
        break;
      case "CompileError":
      case "Ignored":
      case "RuntimeError":
      case "Pending":
        break;
      default:
        throw new TypeError(`Unknown Stryker mutant status: ${result.status}`);
    }
  }
  return counts;
}

function addCounts(total, addition) {
  total.killed += addition.killed;
  total.noCoverage += addition.noCoverage;
  total.survived += addition.survived;
  total.timeout += addition.timeout;
}

async function runShard(shard, files) {
  const shardFiles = files.filter(
    (_, index) => index % SHARD_COUNT === shard - 1
  );
  const shardLabel = String(shard).padStart(2, "0");
  const temporaryDirectory = join(
    tmpdir(),
    `ai-sdk-tool-mutation-${process.pid}-shard-${shardLabel}`
  );
  console.log(
    `MUTATION_SHARD_START shard=${shard}/${SHARD_COUNT} files=${shardFiles.length}`
  );
  try {
    const stryker = new Stryker({
      cleanTempDir: "always",
      concurrency: 4,
      coverageAnalysis: "perTest",
      disableTypeChecks: false,
      jsonReporter: {
        fileName: join(reportsDirectory, `shard-${shardLabel}.json`),
      },
      mutate: shardFiles,
      plugins: ["@stryker-mutator/vitest-runner"],
      reporters: ["progress", "json"],
      tempDirName: temporaryDirectory,
      testRunner: "vitest",
      tsconfigFile: "scripts/quality/stryker-no-tsconfig.json",
      vitest: { configFile: "vitest.config.ts", related: true },
    });
    const counts = countStatuses(await stryker.runMutationTest());
    console.log(
      `MUTATION_SHARD_DONE shard=${shard} killed=${counts.killed} survived=${counts.survived} timeout=${counts.timeout} no-coverage=${counts.noCoverage}`
    );
    return counts;
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function main() {
  const files = collectProductionFiles(join(repositoryRoot, "src"));
  const shards = requestedShards(process.argv.slice(2));
  const total = { killed: 0, noCoverage: 0, survived: 0, timeout: 0 };
  await mkdir(reportsDirectory, { recursive: true });
  console.log(`MUTATION_FILES=${files.length} MUTATION_SHARDS=${SHARD_COUNT}`);
  for (const shard of shards) {
    addCounts(total, await runShard(shard, files));
  }
  console.log(
    `MUTATION_SUMMARY killed=${total.killed} survived=${total.survived} timeout=${total.timeout} no-coverage=${total.noCoverage}`
  );
  if (total.survived > 0 || total.timeout > 0) {
    process.exitCode = 1;
  }
}

await main();
