export { evaluate } from "./evaluate";
export type {
  BenchmarkResult,
  EvaluateOptions,
  AggregatedResult,
  LanguageModelV2Benchmark,
} from "./interfaces";

export { bfclBenchmark } from "./benchmarks/bfcl";
export { summarizationBenchmark } from "./benchmarks/summarization";
export { jsonGenerationBenchmark } from "./benchmarks/json-generation";

export { getAllBenchmarks, getBenchmarkByName } from "./registry";

export * from "./reporters";

// Backwards-compatible helper used by some tests/examples.
export function sum(a: number, b: number) {
  return a + b;
}
