import type { LanguageModelV3Middleware } from "@ai-sdk/provider";
import { createDiskCacheMiddleware } from "@ai-sdk-tool/middleware";
import { type LanguageModel, wrapLanguageModel } from "ai";
import type {
  EvaluateOptions,
  EvaluationResult,
  LanguageModelV3Benchmark,
  ModelConfig,
  ReporterType,
} from "./interfaces";
import { reporters } from "./reporters";

type ModelEntry = [
  string | undefined,
  LanguageModel,
  LanguageModelV3Middleware | LanguageModelV3Middleware[] | undefined,
];

function isModelConfig(value: unknown): value is ModelConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (!("model" in obj)) {
    return false;
  }
  const model = obj.model;
  if (typeof model !== "object" || model === null) {
    return false;
  }
  return "modelId" in (model as Record<string, unknown>);
}

function isLanguageModel(value: unknown): value is LanguageModel {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return "modelId" in obj && typeof obj.modelId === "string";
}

function extractModelAndMiddleware(
  input: LanguageModel | ModelConfig
): [
  LanguageModel,
  LanguageModelV3Middleware | LanguageModelV3Middleware[] | undefined,
] {
  if (isModelConfig(input)) {
    return [input.model, input.middleware];
  }
  return [input, undefined];
}

function normalizeModels(models: EvaluateOptions["models"]): ModelEntry[] {
  const entries: ModelEntry[] = [];

  if (Array.isArray(models)) {
    for (const m of models) {
      const [model, middleware] = extractModelAndMiddleware(m);
      entries.push([undefined, model, middleware]);
    }
  } else if (isModelConfig(models)) {
    entries.push([undefined, models.model, models.middleware]);
  } else if (isLanguageModel(models)) {
    entries.push([undefined, models, undefined]);
  } else {
    for (const [key, m] of Object.entries(models)) {
      const [model, middleware] = extractModelAndMiddleware(m);
      entries.push([key, model, middleware]);
    }
  }

  return entries;
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

function buildEffectiveModel(
  baseModel: LanguageModel,
  userMiddleware:
    | LanguageModelV3Middleware
    | LanguageModelV3Middleware[]
    | undefined,
  cacheOptions: EvaluateOptions["cache"]
): LanguageModel {
  const cacheEnabled = cacheOptions?.enabled === true;

  if (!(cacheEnabled || userMiddleware)) {
    return baseModel;
  }

  const cacheMiddleware = cacheEnabled
    ? createDiskCacheMiddleware({
        cacheDir: cacheOptions.cacheDir ?? ".ai-cache",
        enabled: true,
        debug: cacheOptions.debug ?? false,
      })
    : null;

  const middlewares: LanguageModelV3Middleware[] = [];

  // Order: userMiddleware first (outermost), cache last (innermost)
  // This ensures cache sees transformed params for correct cache key generation
  // Applied as: userMiddleware(cacheMiddleware(model))
  if (userMiddleware) {
    if (Array.isArray(userMiddleware)) {
      middlewares.push(...userMiddleware);
    } else {
      middlewares.push(userMiddleware);
    }
  }

  if (cacheMiddleware) {
    middlewares.push(cacheMiddleware);
  }

  if (middlewares.length === 0) {
    return baseModel;
  }

  return wrapLanguageModel({
    // biome-ignore lint/suspicious/noExplicitAny: AI SDK v5/v6 type mismatch
    model: baseModel as any,
    middleware: middlewares.length === 1 ? middlewares[0] : middlewares,
  });
}

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

  for (const [modelKey, baseModel, userMiddleware] of modelEntries) {
    const effectiveModel = buildEffectiveModel(
      baseModel,
      userMiddleware,
      cache
    );

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
