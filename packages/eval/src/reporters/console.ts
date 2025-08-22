import type { BenchmarkResult, AggregatedResult } from "../interfaces";

export function ConsoleReporterResult(result: BenchmarkResult) {
  console.log(`BENCHMARK: score=${result.score} success=${result.success}`);
  if (result.error) console.error(`ERROR: ${result.error}`);
  if (result.metrics && Object.keys(result.metrics).length) {
    console.log("METRICS:");
    for (const [k, v] of Object.entries(result.metrics)) {
      console.log(`  - ${k}: ${JSON.stringify(v)}`);
    }
  }
  if (result.logs && result.logs.length) {
    console.log("LOGS:");
    for (const l of result.logs) console.log(`  - ${l}`);
  }
}

export function ConsoleReporterAggregate(agg: AggregatedResult) {
  console.log(
    `AGGREGATE: total=${agg.total} avg=${agg.averageScore} successRate=${(
      agg.successRate * 100
    ).toFixed(1)}%`
  );
  if (agg.failures && agg.failures.length) {
    console.log("FAILURES:");
    for (const f of agg.failures) console.log(`  - ${f.error ?? "unknown"}`);
  }
  if (agg.metrics && Object.keys(agg.metrics).length) {
    console.log("AGGREGATE METRICS:");
    for (const [k, v] of Object.entries(agg.metrics))
      console.log(`  - ${k}: ${JSON.stringify(v)}`);
  }
}

export default {
  result: ConsoleReporterResult,
  aggregate: ConsoleReporterAggregate,
};
