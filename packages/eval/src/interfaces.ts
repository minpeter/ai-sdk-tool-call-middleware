import { LanguageModel } from "ai";

/**
 * The result of a single benchmark run.
 */
export interface BenchmarkResult {
  /**
   * A numeric score for the benchmark.
   * The interpretation of this score is up to the benchmark author.
   */
  score: number;

  /**
   * A boolean indicating whether the benchmark passed or failed,
   * based on a threshold defined by the author.
   */
  success: boolean;

  /**
   * A key-value map of additional metrics.
   * e.g., { "accuracy": 0.9, "f1_score": 0.88 }
   */
  metrics: Record<string, number | string>;

  /**
   * Optional logs or detailed output from the benchmark run.
   */
  logs?: string[];

  /**
   * An error object if the benchmark failed unexpectedly.
   */
  error?: Error;
}

/**
 * The interface for defining a language model benchmark.
 */
export interface LanguageModelV2Benchmark {
  /**
   * A unique name for the benchmark.
   */
  name: string;

  /**
   * The version of the benchmark.
   */
  version: string;

  /**
   * A brief description of what the benchmark evaluates.
   */
  description: string;

  /**
   * The function that runs the evaluation logic.
   * @param model - The language model instance to be evaluated.
   * @param config - Optional configuration for the benchmark run.
   * @returns A promise that resolves to a BenchmarkResult.
   */
  run(
    model: LanguageModel,
    config?: Record<string, any>
  ): Promise<BenchmarkResult>;
}

/**
 * The supported reporter types.
 */
export type ReporterType = "console" | "json" | "console.debug";

/**
 * The full result object for an evaluation run,
 * containing results for all model-benchmark combinations.
 */
export interface EvaluationResult {
  model: string; // A string identifier for the model
  benchmark: string; // The name of the benchmark
  result: BenchmarkResult;
}

/**
 * Options for the `evaluate` function.
 */
export interface EvaluateOptions {
  /**
   * The language model or models to evaluate.
   */
  models: LanguageModel | LanguageModel[];

  /**
   * An array of benchmarks to run against the models.
   */
  benchmarks: LanguageModelV2Benchmark[];

  /**
   * The reporter to use for displaying results.
   * Defaults to 'console'.
   */
  reporter?: ReporterType;
}
