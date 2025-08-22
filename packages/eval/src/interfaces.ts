import type { LanguageModel } from "ai";

/**
 * Result produced by a benchmark run.
 */
export type BenchmarkResult = {
  score: number;
  success: boolean;
  metrics: Record<string, unknown>;
  logs: string[];
  error?: string;
};

/**
 * Core benchmark interface for language models.
 */
/**
 * New interface required by the PRD: a benchmark that runs against the
 * `LanguageModel` type exported by the `ai` package. The run method accepts an
 * optional `config` parameter for per-run configuration.
 */
export interface LanguageModelV2Benchmark {
  name: string;
  version: string;
  description: string;
  run(
    model?: LanguageModel,
    config?: Record<string, unknown>
  ): Promise<BenchmarkResult>;
}

// Backward-compatible alias for existing code that referenced the older name.
export type LanguageModelBenchmark = LanguageModelV2Benchmark;

/**
 * Options for the evaluate function.
 */
export type EvaluateOptions = {
  matrix: {
    models: Array<{
      name: string;
      model?: LanguageModel;
      config?: Record<string, unknown>;
    }>;
  };
  benchmarks: LanguageModelBenchmark[];
  reporter?: (result: BenchmarkResult) => void;
  /** Called once after all benchmark runs complete with aggregated statistics */
  aggregateReporter?: (agg: AggregatedResult) => void;
  /** When provided, write aggregated result JSON to this filesystem path */
  persistPath?: string;
  /** Choose a built-in reporter by name */
  reporterType?: "console" | "json" | "markdown";
  concurrency?: number; // optional concurrency limit for orchestration
  retries?: number; // optional retry count for failed benchmark runs
  failFast?: boolean; // whether to abort on first failure
  backoffBaseMs?: number; // base milliseconds for exponential backoff
};

export type { BenchmarkResult as EvalBenchmarkResult };

/** Aggregated statistics computed from a collection of benchmark results */
export type AggregatedResult = {
  total: number;
  averageScore: number;
  successRate: number; // 0..1
  failures: Array<{ error?: string }>;
  metrics: Record<string, unknown>;
};
