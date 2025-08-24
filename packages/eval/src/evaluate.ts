import { LanguageModel } from "ai";
import {
  EvaluateOptions,
  EvaluationResult,
  LanguageModelV2Benchmark,
} from "./interfaces.js";
import { reporters } from "./reporters/index.js";

async function runSingleBenchmark(
  model: LanguageModel,
  benchmark: LanguageModelV2Benchmark
): Promise<EvaluationResult> {
  const modelId =
    typeof model === "object" &&
    model !== null &&
    "modelId" in model &&
    typeof model.modelId === "string"
      ? model.modelId
      : "unknown-model";

  try {
    console.log(`[${modelId}] Running benchmark: ${benchmark.name}...`);
    const result = await benchmark.run(model);
    console.log(
      `[${modelId}] Finished benchmark: ${benchmark.name}. Score: ${result.score}`
    );
    return {
      model: modelId,
      benchmark: benchmark.name,
      result,
    };
  } catch (error) {
    console.error(
      `[${modelId}] Error running benchmark: ${benchmark.name}`,
      error
    );
    return {
      model: modelId,
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

  const modelsArray = Array.isArray(models) ? models : [models];
  const allResults: EvaluationResult[] = [];

  for (const model of modelsArray) {
    for (const benchmark of benchmarks) {
      const evaluationResult = await runSingleBenchmark(model, benchmark);
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
