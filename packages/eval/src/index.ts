// Core evaluation function

// Built-in benchmarks
export {
  bfclMultipleBenchmark,
  bfclParallelBenchmark,
  bfclParallelMultipleBenchmark,
  bfclSimpleBenchmark,
} from "./benchmarks/bfcl";
export {
  jsonGenerationBenchmark,
  jsonGenerationSchemaOnlyBenchmark,
} from "./benchmarks/json-generation";
export { evaluate } from "./evaluate";

// Core interfaces for custom benchmarks
export type {
  BenchmarkResult,
  EvaluateOptions,
  LanguageModelV3Benchmark,
  ReporterType,
} from "./interfaces";
