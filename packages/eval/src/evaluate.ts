import { LanguageModel } from "ai";
import {
  EvaluateOptions,
  EvaluationResult,
  LanguageModelV2Benchmark,
} from "./interfaces";
import { reporters } from "./reporters";

async function runSingleBenchmark(
  model: LanguageModel,
  benchmark: LanguageModelV2Benchmark,
  modelKey?: string
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
    const result = await benchmark.run(model);
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
  const { models, benchmarks, reporter = "console" } = options;

  const modelEntries: Array<[string | undefined, LanguageModel]> = [];
  if (Array.isArray(models)) {
    for (const m of models) modelEntries.push([undefined, m]);
  } else if (
    typeof models === "object" &&
    models !== null &&
    "modelId" in (models as any)
  ) {
    modelEntries.push([undefined, models as LanguageModel]);
  } else {
    for (const [key, m] of Object.entries(
      models as Record<string, LanguageModel>
    )) {
      modelEntries.push([key, m]);
    }
  }
  const allResults: EvaluationResult[] = [];

  for (const [modelKey, model] of modelEntries) {
    for (const benchmark of benchmarks) {
      const evaluationResult = await runSingleBenchmark(
        model,
        benchmark,
        modelKey
      );
      allResults.push(evaluationResult);
    }
  }

  const report = reporters[reporter];
  if (report) {
    report(allResults);
  } else {
    console.warn(`Unknown reporter: '${reporter}'. Defaulting to console.`);
    reporters.console(allResults);
  }

  return allResults;
}
