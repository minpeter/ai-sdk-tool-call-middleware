import type { BenchmarkResult, LanguageModelV2Benchmark } from "./interfaces";

// sanity compile-time checks
type _BR = BenchmarkResult;

const sample: _BR = {
  score: 0.9,
  success: true,
  metrics: { accuracy: 0.9 },
  logs: ["ok"],
};

// Benchmark interface shape check
const fakeBenchmark: LanguageModelV2Benchmark = {
  name: "fake",
  version: "1.0",
  description: "desc",
  run: async _model => sample,
};

void fakeBenchmark;
