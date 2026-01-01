import { createDiskCacheMiddleware } from "@ai-sdk-tool/middleware";
import { type LanguageModel, wrapLanguageModel } from "ai";
import type {
  EvaluateOptions,
  EvaluationResult,
  LanguageModelV3Benchmark,
  ReporterType,
} from "./interfaces";
import { reporters } from "./reporters";

async function runSingleBenchmark(
  model: LanguageModel,
  benchmark: LanguageModelV3Benchmark,
  modelKey?: string,
  config?: Record<string, unknown>
): Promise<EvaluationResult> {
  const modelId =
    typeof model === "object" &&
    model !== null &&
    "modelId" in model &&
    typeof model.modelId === "string"
      ? model.modelId
      : "unknown-model";

  try {
    console.log(
      `[${modelId}]${modelKey ? ` (${modelKey})` : ""} Running benchmark: ${benchmark.name}...`
    );
    const result = await benchmark.run(model, config);
    console.log(
      `[${modelId}]${modelKey ? ` (${modelKey})` : ""} Finished benchmark: ${benchmark.name}. Score: ${result.score}`
    );
    return {
      model: modelId,
      modelKey,
      benchmark: benchmark.name,
      result,
    };
  } catch (error) {
    console.error(
      `[${modelId}]${modelKey ? ` (${modelKey})` : ""} Error running benchmark: ${benchmark.name}`,
      error
    );
    return {
      model: modelId,
      modelKey,
      benchmark: benchmark.name,
      result: {
        score: 0,
        success: false,
        metrics: {},
        error: error instanceof Error ? error : new Error(String(error)),
      },
    };
  }
}

function normalizeModels(
  models: LanguageModel | LanguageModel[] | Record<string, LanguageModel>
): [string | undefined, LanguageModel][] {
  const modelEntries: [string | undefined, LanguageModel][] = [];

  if (Array.isArray(models)) {
    for (const m of models) {
      modelEntries.push([undefined, m]);
    }
  } else if (
    typeof models === "object" &&
    models !== null &&
    "modelId" in (models as Record<string, unknown>)
  ) {
    modelEntries.push([undefined, models as unknown as LanguageModel]);
  } else {
    for (const [key, m] of Object.entries(
      models as Record<string, LanguageModel>
    )) {
      modelEntries.push([key, m]);
    }
  }

  return modelEntries;
}

function buildConfig(
  temperature?: number,
  maxTokens?: number
): Record<string, unknown> | undefined {
  const config: Record<string, unknown> = {};
  if (temperature !== undefined) {
    config.temperature = temperature;
  }
  if (maxTokens !== undefined) {
    config.maxTokens = maxTokens;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function executeReporter(
  reporter: ReporterType,
  results: EvaluationResult[]
): void {
  const report = reporters[reporter];
  if (report) {
    report(results);
  } else {
    console.warn(`Unknown reporter: '${reporter}'. Defaulting to console.`);
    reporters.console(results);
  }
}

function wrapWithCache(
  model: LanguageModel,
  cacheOptions: NonNullable<EvaluateOptions["cache"]>
): LanguageModel {
  const middleware = createDiskCacheMiddleware({
    cacheDir: cacheOptions.cacheDir ?? ".ai-cache",
    enabled: cacheOptions.enabled ?? true,
    debug: cacheOptions.debug ?? false,
  });

  // biome-ignore lint/suspicious/noExplicitAny: AI SDK v5/v6 type mismatch - LanguageModel vs LanguageModelV3
  return wrapLanguageModel({ model: model as any, middleware });
}

export async function evaluate(
  options: EvaluateOptions
): Promise<EvaluationResult[]> {
  const {
    models,
    benchmarks,
    reporter = "console",
    temperature,
    maxTokens,
    cache,
  } = options;

  const modelEntries = normalizeModels(models);
  const config = buildConfig(temperature, maxTokens);
  const allResults: EvaluationResult[] = [];

  for (const [modelKey, model] of modelEntries) {
    const effectiveModel =
      cache?.enabled === true ? wrapWithCache(model, cache) : model;

    for (const benchmark of benchmarks) {
      const evaluationResult = await runSingleBenchmark(
        effectiveModel,
        benchmark,
        modelKey,
        config
      );
      allResults.push(evaluationResult);
    }
  }

  executeReporter(reporter, allResults);
  return allResults;
}
