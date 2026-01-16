import type { LanguageModelV3Middleware } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";

/**
 * Model configuration for evaluation.
 * Allows specifying a base model with optional middleware for proper cache ordering.
 */
export interface ModelConfig {
  /**
   * The base language model (before any middleware is applied).
   */
  model: LanguageModel;

  /**
   * Optional middleware to apply to the model.
   * When cache is enabled, the cache middleware will be applied BEFORE this middleware,
   * ensuring that cache keys are generated from the final transformed params.
   */
  middleware?: LanguageModelV3Middleware | LanguageModelV3Middleware[];
}

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
export interface LanguageModelV3Benchmark {
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
    config?: Record<string, unknown>
  ): Promise<BenchmarkResult>;
}

/**
 * The supported reporter types.
 */
export type ReporterType =
  | "console"
  | "json"
  | "console.debug"
  | "console.summary"
  | "none";

/**
 * The full result object for an evaluation run,
 * containing results for all model-benchmark combinations.
 */
export interface EvaluationResult {
  model: string; // A string identifier for the model
  /** Optional user-provided key when models are passed as a keyed map */
  modelKey?: string;
  benchmark: string; // The name of the benchmark
  result: BenchmarkResult;
}

/**
 * Options for the `evaluate` function.
 */
export interface EvaluateOptions {
  /**
   * The language model or models to evaluate.
   * Can be:
   * - A single LanguageModel or ModelConfig
   * - An array of LanguageModel or ModelConfig
   * - A keyed record of LanguageModel or ModelConfig
   *
   * When using ModelConfig with middleware and cache enabled,
   * the cache middleware is applied innermost (closest to the model),
   * ensuring cache keys reflect the final transformed params.
   */
  models:
    | LanguageModel
    | ModelConfig
    | (LanguageModel | ModelConfig)[]
    | Record<string, LanguageModel | ModelConfig>;

  /**
   * An array of benchmarks to run against the models.
   */
  benchmarks: LanguageModelV3Benchmark[];

  /**
   * The reporter to use for displaying results.
   * Defaults to 'console'.
   */
  reporter?: ReporterType;

  /**
   * Optional temperature setting to pass to model generation during evaluation.
   */
  temperature?: number;

  /**
   * Optional maximum number of tokens to generate during evaluation.
   */
  maxTokens?: number;

  /**
   * Options for disk-based response caching.
   * When enabled, LLM responses are cached to disk to avoid redundant API calls.
   */
  cache?: {
    /**
     * Whether to enable disk caching.
     * @default false
     */
    enabled?: boolean;

    /**
     * Directory to store cache files.
     * @default '.ai-cache'
     */
    cacheDir?: string;

    /**
     * Whether to log cache hits/misses for debugging.
     * @default false
     */
    debug?: boolean;
  };

  /**
   * Provider-specific options to pass to generateText calls.
   * These options are passed directly to the underlying model provider.
   *
   * @example
   * ```ts
   * // Enable reasoning for OpenRouter models that support it
   * providerOptions: {
   *   openrouter: {
   *     reasoning: { enabled: true }
   *   }
   * }
   * ```
   */
  providerOptions?: Record<string, Record<string, unknown>>;
}
