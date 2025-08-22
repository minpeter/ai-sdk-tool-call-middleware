import type { BenchmarkResult, AggregatedResult } from "./interfaces";

export function aggregateResults(results: BenchmarkResult[]): AggregatedResult {
  const total = results.length;
  const sum = results.reduce(
    (s, r) => s + (typeof r.score === "number" ? r.score : 0),
    0
  );
  const averageScore = total === 0 ? 0 : sum / total;
  const successes = results.filter(r => r.success).length;
  const successRate = total === 0 ? 0 : successes / total;
  const failures = results
    .filter(r => !r.success)
    .map(r => ({ error: r.error }));

  // naive metrics merge: attach last-seen metric values
  const metrics: Record<string, unknown> = {};
  for (const r of results) {
    for (const k of Object.keys(r.metrics || {})) {
      metrics[k] = r.metrics[k];
    }
  }

  return {
    total,
    averageScore,
    successRate,
    failures,
    metrics,
  };
}

export default aggregateResults;
