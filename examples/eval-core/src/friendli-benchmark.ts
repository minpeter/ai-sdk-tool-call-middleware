import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  bfclMultipleBenchmark,
  bfclParallelBenchmark,
  bfclParallelMultipleBenchmark,
  bfclSimpleBenchmark,
  complexFuncBenchBenchmark,
  evaluate,
  type LanguageModelV3Benchmark,
  type ReporterType,
} from "@ai-sdk-tool/eval";
import { morphXmlToolMiddleware } from "@ai-sdk-tool/parser";
import { type LanguageModel, wrapLanguageModel } from "ai";

const FRIENDLI_BASE_URL = "https://api.friendli.ai/serverless/v1";

interface ModelConfig {
  id: string;
  displayName: string;
  hasNativeToolCall: boolean;
  needsMiddleware: boolean;
}

const FRIENDLI_MODELS: ModelConfig[] = [
  {
    id: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
    displayName: "llama4-scout",
    hasNativeToolCall: false,
    needsMiddleware: true,
  },
  {
    id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct",
    displayName: "llama4-maverick",
    hasNativeToolCall: false,
    needsMiddleware: true,
  },
  {
    id: "deepseek-ai/DeepSeek-R1-0528",
    displayName: "deepseek-r1",
    hasNativeToolCall: false,
    needsMiddleware: true,
  },
  {
    id: "meta-llama-3.3-70b-instruct",
    displayName: "llama3.3-70b-native",
    hasNativeToolCall: true,
    needsMiddleware: false,
  },
  {
    id: "Qwen/Qwen3-32B",
    displayName: "qwen3-32b-native",
    hasNativeToolCall: true,
    needsMiddleware: false,
  },
];

function createFriendliProvider() {
  const token = process.env.FRIENDLI_TOKEN;
  if (!token) {
    throw new Error("FRIENDLI_TOKEN environment variable is required");
  }

  return createOpenAICompatible({
    name: "friendli.serverless",
    apiKey: token,
    baseURL: FRIENDLI_BASE_URL,
  });
}

function createModelWithMiddleware(
  provider: ReturnType<typeof createOpenAICompatible>,
  modelConfig: ModelConfig
): LanguageModel {
  const baseModel = provider(modelConfig.id);

  if (modelConfig.needsMiddleware) {
    return wrapLanguageModel({
      model: baseModel,
      middleware: morphXmlToolMiddleware,
    });
  }

  return baseModel;
}

type BenchmarkType =
  | "simple"
  | "parallel"
  | "multiple"
  | "parallel-multiple"
  | "complex"
  | "all";

const BENCHMARK_MAP: Record<
  Exclude<BenchmarkType, "all">,
  LanguageModelV3Benchmark
> = {
  simple: bfclSimpleBenchmark,
  parallel: bfclParallelBenchmark,
  multiple: bfclMultipleBenchmark,
  "parallel-multiple": bfclParallelMultipleBenchmark,
  complex: complexFuncBenchBenchmark,
};

function getBenchmarks(type: BenchmarkType): LanguageModelV3Benchmark[] {
  if (type === "all") {
    return Object.values(BENCHMARK_MAP);
  }

  const benchmark = BENCHMARK_MAP[type];
  if (!benchmark) {
    throw new Error(`Unknown benchmark type: ${type}`);
  }

  return [benchmark];
}

function getModelsToTest(
  provider: ReturnType<typeof createOpenAICompatible>,
  modelFilter?: string
): Record<string, LanguageModel> {
  let modelsToUse = FRIENDLI_MODELS;

  if (modelFilter) {
    const filterNames = modelFilter
      .split(",")
      .map((s) => s.trim().toLowerCase());
    modelsToUse = FRIENDLI_MODELS.filter((m) =>
      filterNames.some(
        (f) =>
          m.displayName.toLowerCase().includes(f) ||
          m.id.toLowerCase().includes(f)
      )
    );

    if (modelsToUse.length === 0) {
      console.error(`No models matched filter: ${modelFilter}`);
      console.error(
        "Available models:",
        FRIENDLI_MODELS.map((m) => m.displayName).join(", ")
      );
      process.exit(1);
    }
  }

  const models: Record<string, LanguageModel> = {};

  for (const config of modelsToUse) {
    const suffix = config.needsMiddleware ? "-xml" : "";
    const key = `${config.displayName}${suffix}`;
    models[key] = createModelWithMiddleware(provider, config);
  }

  return models;
}

async function main() {
  console.log("=".repeat(70));
  console.log("Friendli Benchmark Suite");
  console.log("=".repeat(70));
  console.log();

  const reporterEnv = process.env.EVAL_REPORTER as ReporterType | undefined;
  const benchmarkType = (process.env.BENCHMARK_TYPE || "all") as BenchmarkType;
  const modelFilter = process.env.MODEL_FILTER;
  const limit = process.env.BFCL_LIMIT;
  const concurrency = process.env.BFCL_CONCURRENCY || "4";

  console.log("Configuration:");
  console.log(`  Benchmark Type: ${benchmarkType}`);
  console.log(`  Model Filter: ${modelFilter || "(all models)"}`);
  console.log(`  Test Limit: ${limit || "(no limit)"}`);
  console.log(`  Concurrency: ${concurrency}`);
  console.log(`  Reporter: ${reporterEnv || "console.debug"}`);
  console.log();

  const provider = createFriendliProvider();
  const modelsToTest = getModelsToTest(provider, modelFilter);
  const benchmarks = getBenchmarks(benchmarkType);

  console.log("Models to test:");
  for (const name of Object.keys(modelsToTest)) {
    console.log(`  - ${name}`);
  }
  console.log();

  console.log("Benchmarks to run:");
  for (const b of benchmarks) {
    console.log(`  - ${b.name}`);
  }
  console.log();

  console.log("Starting evaluation...\n");

  const startTime = Date.now();

  await evaluate({
    models: modelsToTest,
    benchmarks,
    reporter: reporterEnv ?? "console.debug",
    temperature: 0.0,
    maxTokens: 1024,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log();
  console.log("=".repeat(70));
  console.log(`Benchmark complete! Total time: ${elapsed}s`);
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
