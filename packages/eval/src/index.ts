export { evaluate } from "./evaluate";
export type {
  BenchmarkResult,
  EvaluateOptions,
  AggregatedResult,
  LanguageModelV2Benchmark,
} from "./interfaces";

export { bfclBenchmark } from "./benchmarks/bfcl";
// convenience alias for examples/PRD-style imports
export { bfclBenchmark as bfcl } from "./benchmarks/bfcl";
export { summarizationBenchmark } from "./benchmarks/summarization";
export { jsonGenerationBenchmark } from "./benchmarks/json-generation";

export { getAllBenchmarks, getBenchmarkByName } from "./registry";

// Export BFCL data loader utilities so examples can load datasets from the
// package public entrypoint.
export {
  loadLocalDataset,
  cacheDataset,
  loadCachedDataset,
} from "./data/bfcl/loader";
export type { BfclDataset } from "./data/bfcl/types";

export * from "./reporters";

// Backwards-compatible helper used by some tests/examples.
export function sum(a: number, b: number) {
  return a + b;
}
