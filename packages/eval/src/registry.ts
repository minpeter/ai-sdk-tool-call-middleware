import { bfclBenchmark } from "./benchmarks/bfcl";
import { summarizationBenchmark } from "./benchmarks/summarization";
import { jsonGenerationBenchmark } from "./benchmarks/json-generation";
import type { LanguageModelV2Benchmark } from "./interfaces";

const BUILT_INS: LanguageModelV2Benchmark[] = [
  bfclBenchmark,
  summarizationBenchmark,
  jsonGenerationBenchmark,
];

export function getAllBenchmarks() {
  return BUILT_INS.slice();
}

export function getBenchmarkByName(name: string) {
  return BUILT_INS.find(b => b.name === name) as
    | LanguageModelV2Benchmark
    | undefined;
}

export function getBenchmarksByCategory(_category: string) {
  // categories are not defined on benchmarks yet; placeholder for future
  return BUILT_INS.slice();
}

export default {
  getAllBenchmarks,
  getBenchmarkByName,
  getBenchmarksByCategory,
};
