// Core evaluation function
export { evaluate } from "./evaluate.js";

// Built-in benchmarks
export { jsonGenerationBenchmark } from "./benchmarks/json-generation.js";
export {
  bfclSimpleBenchmark,
  bfclParallelBenchmark,
  bfclMultipleBenchmark,
  bfclParallelMultipleBenchmark,
} from "./benchmarks/bfcl.js";

// Core interfaces for custom benchmarks
export type {
  LanguageModelV2Benchmark,
  BenchmarkResult,
  EvaluateOptions,
  ReporterType,
} from "./interfaces.js";
