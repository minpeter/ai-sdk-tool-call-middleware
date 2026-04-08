/// <reference types="node" />

import { fileURLToPath } from "node:url";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV3Middleware } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import {
  hermesToolMiddleware,
  morphXmlToolMiddleware,
  qwen3CoderToolMiddleware,
  yamlXmlToolMiddleware,
} from "../src/preconfigured-middleware";

async function loadEval() {
  const evalRepoBase = new URL("../../ai-sdk-eval/", import.meta.url);
  const localDist = new URL("dist/index.js", evalRepoBase).href;

  try {
    const mod = await import(localDist);
    if (!process.env.BFCL_DATA_DIR) {
      process.env.BFCL_DATA_DIR = fileURLToPath(new URL("data", evalRepoBase));
    }
    return mod;
  } catch (err) {
    console.warn(
      "Local ai-sdk-eval not found, falling back to npm package:",
      (err as Error).message
    );
    const pkg = "@ai-sdk-tool/eval";
    return await import(pkg);
  }
}

const BENCHMARK_NAMES = [
  "simple",
  "parallel",
  "multiple",
  "parallel-multiple",
  "all",
] as const;
type BenchmarkName = (typeof BENCHMARK_NAMES)[number];

const PROTOCOL_NAMES = ["morphXml", "hermes", "yamlXml", "qwen3Coder"] as const;
type ProtocolName = (typeof PROTOCOL_NAMES)[number];

const MODE_NAMES = ["native", "middleware", "both"] as const;
type ModeName = (typeof MODE_NAMES)[number];

const REPORTER_NAMES = [
  "console",
  "console.summary",
  "console.debug",
  "json",
  "none",
] as const;
type ReporterName = (typeof REPORTER_NAMES)[number];

interface Options {
  benchmark: BenchmarkName;
  cache: boolean;
  dryRun: boolean;
  maxTokens: number;
  mode: ModeName;
  model: string;
  protocol: ProtocolName;
  reporter: ReporterName;
  temperature: number;
}

function readArg(name: string): string | undefined {
  const argv = process.argv;
  const flag = `--${name}`;
  const prefix = `${flag}=`;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      return argv[i + 1];
    }
    if (argv[i]?.startsWith(prefix)) {
      return argv[i]?.slice(prefix.length);
    }
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseOptions(): Options {
  return {
    model: readArg("model") ?? "google/gemini-3.1-pro-preview",
    benchmark: (readArg("benchmark") ?? "simple") as BenchmarkName,
    mode: (readArg("mode") ?? "both") as ModeName,
    protocol: (readArg("protocol") ?? "morphXml") as ProtocolName,
    reporter: (readArg("reporter") ?? "console.summary") as ReporterName,
    temperature: Number(readArg("temperature") ?? "0"),
    maxTokens: Number(readArg("max-tokens") ?? "4096"),
    cache: hasFlag("cache"),
    dryRun: hasFlag("dry-run"),
  };
}

const MIDDLEWARE_MAP: Record<ProtocolName, LanguageModelV3Middleware> = {
  morphXml: morphXmlToolMiddleware,
  hermes: hermesToolMiddleware,
  yamlXml: yamlXmlToolMiddleware,
  qwen3Coder: qwen3CoderToolMiddleware,
};

function validateOptions(opts: Options) {
  if (!BENCHMARK_NAMES.includes(opts.benchmark)) {
    console.error(
      `Invalid benchmark: ${opts.benchmark}. Valid: ${BENCHMARK_NAMES.join(", ")}`
    );
    process.exit(1);
  }
  if (!MODE_NAMES.includes(opts.mode)) {
    console.error(
      `Invalid mode: ${opts.mode}. Valid: ${MODE_NAMES.join(", ")}`
    );
    process.exit(1);
  }
  if (!PROTOCOL_NAMES.includes(opts.protocol)) {
    console.error(
      `Invalid protocol: ${opts.protocol}. Valid: ${PROTOCOL_NAMES.join(", ")}`
    );
    process.exit(1);
  }
  if (!(REPORTER_NAMES as readonly string[]).includes(opts.reporter)) {
    console.error(
      `Invalid reporter: ${opts.reporter}. Valid: ${REPORTER_NAMES.join(", ")}`
    );
    process.exit(1);
  }
  if (!Number.isFinite(opts.temperature)) {
    console.error(
      `Invalid temperature: ${readArg("temperature")}. Must be a number.`
    );
    process.exit(1);
  }
  if (!Number.isFinite(opts.maxTokens) || opts.maxTokens <= 0) {
    console.error(
      `Invalid max-tokens: ${readArg("max-tokens")}. Must be a positive number.`
    );
    process.exit(1);
  }
}

function printConfig(opts: Options) {
  console.log("=== BFCL Benchmark: Native vs Middleware ===");
  console.log(`  Base URL:    ${process.env.AI_BASE_URL ?? "(not set)"}`);
  console.log(`  Model:       ${opts.model}`);
  console.log(`  Benchmark:   ${opts.benchmark}`);
  console.log(`  Mode:        ${opts.mode}`);
  console.log(`  Protocol:    ${opts.protocol}`);
  console.log(`  Temperature: ${opts.temperature}`);
  console.log(`  Max Tokens:  ${opts.maxTokens}`);
  console.log(`  Cache:       ${opts.cache}`);
  console.log(`  Reporter:    ${opts.reporter}`);
  console.log();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required.`);
    process.exit(1);
  }
  return value;
}

function buildModels(
  baseModel: LanguageModel,
  opts: Options
): Record<
  string,
  | LanguageModel
  | { model: LanguageModel; middleware: LanguageModelV3Middleware }
> {
  const models: Record<
    string,
    | LanguageModel
    | { model: LanguageModel; middleware: LanguageModelV3Middleware }
  > = {};

  if (opts.mode === "native" || opts.mode === "both") {
    models[`${opts.model} (native)`] = baseModel;
  }

  if (opts.mode === "middleware" || opts.mode === "both") {
    models[`${opts.model} (${opts.protocol})`] = {
      model: baseModel,
      middleware: MIDDLEWARE_MAP[opts.protocol],
    };
  }

  return models;
}

const PAD_WIDTH = 45;

function printSummary(
  results: {
    benchmark: string;
    modelKey?: string;
    model: string;
    result: { metrics: Record<string, number | string>; score: number };
  }[]
) {
  console.log("\n=== Summary ===\n");

  const grouped = new Map<string, typeof results>();
  for (const r of results) {
    const bucket = grouped.get(r.benchmark) ?? [];
    bucket.push(r);
    grouped.set(r.benchmark, bucket);
  }

  for (const [benchmark, group] of grouped) {
    console.log(`  ${benchmark}`);
    for (const r of group) {
      const label = r.modelKey ?? r.model;
      const accuracy =
        typeof r.result.metrics.accuracy === "number"
          ? (Number(r.result.metrics.accuracy) * 100).toFixed(1)
          : "n/a";
      const score = r.result.score.toFixed(4);
      console.log(
        `    ${label.padEnd(PAD_WIDTH)} accuracy=${accuracy}%  score=${score}`
      );
    }
    console.log();
  }
}

async function main() {
  const opts = parseOptions();
  validateOptions(opts);
  printConfig(opts);

  if (opts.dryRun) {
    console.log("Dry run — exiting.");
    return;
  }

  const apiKey = requireEnv("AI_API_KEY");
  const baseURL = requireEnv("AI_BASE_URL");

  const evalModule = await loadEval();

  const provider = createOpenAICompatible({
    name: "ai-provider",
    apiKey,
    baseURL,
  });

  const baseModel = provider(opts.model);

  const benchmarkMap = {
    simple: [evalModule.bfclSimpleBenchmark],
    parallel: [evalModule.bfclParallelBenchmark],
    multiple: [evalModule.bfclMultipleBenchmark],
    "parallel-multiple": [evalModule.bfclParallelMultipleBenchmark],
    all: [
      evalModule.bfclSimpleBenchmark,
      evalModule.bfclParallelBenchmark,
      evalModule.bfclMultipleBenchmark,
      evalModule.bfclParallelMultipleBenchmark,
    ],
  };
  const benchmarks = benchmarkMap[opts.benchmark];
  const models = buildModels(baseModel, opts);

  console.log(
    `Running ${benchmarks.length} benchmark(s) x ${Object.keys(models).length} model config(s)...\n`
  );

  const results = await evalModule.evaluate({
    models,
    benchmarks,
    reporter: opts.reporter,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    cache: opts.cache
      ? { enabled: true, cacheDir: ".ai-cache/bfcl-benchmark" }
      : undefined,
  });

  printSummary(results);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
