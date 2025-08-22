import type { BenchmarkResult, AggregatedResult } from "../interfaces";

export function JsonReporterResult(result: BenchmarkResult) {
  // print compact JSON per result, ensure stable shape
  const out = {
    score: result.score,
    success: result.success,
    error: result.error,
    metrics: result.metrics ?? {},
    logs: result.logs ?? [],
  };
  console.log(JSON.stringify(out));
}

export function JsonReporterAggregate(agg: AggregatedResult) {
  const out = {
    total: agg.total,
    averageScore: agg.averageScore,
    successRate: agg.successRate,
    failures: agg.failures ?? [],
    metrics: agg.metrics ?? {},
  };
  console.log(JSON.stringify(out, null, 2));
}

export default {
  result: JsonReporterResult,
  aggregate: JsonReporterAggregate,
};
