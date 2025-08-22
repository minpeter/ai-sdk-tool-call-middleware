import type { BenchmarkResult, AggregatedResult } from "../interfaces";

export function MarkdownReporterResult(result: BenchmarkResult) {
  let md = `### Benchmark Result\n`;
  md += `- Score: ${result.score}\n`;
  md += `- Success: ${result.success}\n`;
  if (result.error) md += `- Error: ${result.error}\n`;
  const metrics = result.metrics ?? {};
  if (Object.keys(metrics).length)
    md +=
      `- Metrics: \n` +
      Object.entries(metrics)
        .map(([k, v]) => `  - ${k}: ${JSON.stringify(v)}`)
        .join("\n") +
      "\n";
  const logs = result.logs ?? [];
  if (logs.length)
    md += `- Logs: \n` + logs.map(l => `  - ${l}`).join("\n") + "\n";
  console.log(md);
}

export function MarkdownReporterAggregate(agg: AggregatedResult) {
  let md = `## Aggregated Results\n`;
  md += `- Total: ${agg.total}\n`;
  md += `- Average Score: ${agg.averageScore}\n`;
  md += `- Success Rate: ${(agg.successRate * 100).toFixed(1)}%\n`;
  const failures = agg.failures ?? [];
  if (failures.length)
    md +=
      `- Failures: \n` +
      failures.map(f => `  - ${f.error ?? "unknown"}`).join("\n") +
      "\n";
  const metrics = agg.metrics ?? {};
  if (Object.keys(metrics).length)
    md +=
      `- Metrics: \n` +
      Object.entries(metrics)
        .map(([k, v]) => `  - ${k}: ${JSON.stringify(v)}`)
        .join("\n") +
      "\n";
  console.log(md);
}

export default {
  result: MarkdownReporterResult,
  aggregate: MarkdownReporterAggregate,
};
