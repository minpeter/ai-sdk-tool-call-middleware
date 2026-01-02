#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";

interface BenchmarkResult {
  commit: string;
  branch: string;
  timestamp: string;
  mode: "fast" | "full";
  results: {
    qwen: Record<string, Record<string, number>>;
    glm: Record<string, Record<string, number>>;
    deepseek: Record<string, Record<string, number>>;
  };
}

type ModelKey = "qwen" | "glm" | "deepseek";

const MODEL_KEYS: ModelKey[] = ["qwen", "glm", "deepseek"];

const MODEL_DISPLAY_NAMES: Record<ModelKey, string> = {
  qwen: "Qwen/Qwen3-235B-A22B-Instruct-2507",
  glm: "zai-org/GLM-4.6",
  deepseek: "deepseek-ai/DeepSeek-R1-0528",
};

function loadHistory(): BenchmarkResult[] {
  const historyFile = path.join(
    process.cwd(),
    ".benchmark-results/history.jsonl"
  );

  if (!fs.existsSync(historyFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(historyFile, "utf-8")
    .split("\n")
    .filter((l) => l.trim());
  return lines.map((line) => JSON.parse(line));
}

function loadCurrentResult(): BenchmarkResult {
  const resultsDir = path.join(process.cwd(), ".benchmark-results");
  const files = fs
    .readdirSync(resultsDir)
    .filter((f) => f.startsWith("benchmark-") && f.endsWith(".json"))
    .sort()
    .reverse();

  if (files.length === 0) {
    throw new Error("No benchmark results found");
  }

  const latestFile = path.join(resultsDir, files[0]);
  return JSON.parse(fs.readFileSync(latestFile, "utf-8"));
}

interface ModelComparison {
  protocol: string;
  benchmark: string;
  current: number;
  baseline: number;
  diff: number;
  regression: boolean;
}

interface TrendResult {
  hasBaseline: boolean;
  message?: string;
  baselineSampleSize?: number;
  comparisons?: Record<ModelKey, ModelComparison[]>;
  hasRegression?: boolean;
}

function calculateBaselineAverage(
  mainBranchResults: BenchmarkResult[],
  modelKey: ModelKey,
  protocol: string,
  benchmark: string
): number | null {
  let sum = 0;
  let count = 0;
  for (const result of mainBranchResults) {
    const score = result.results[modelKey]?.[protocol]?.[benchmark];
    if (score !== undefined) {
      sum += score;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

function processModelComparisons(
  modelKey: ModelKey,
  currentModelResults: Record<string, Record<string, number>>,
  mainBranchResults: BenchmarkResult[]
): { comparisons: ModelComparison[]; hasRegression: boolean } {
  const comparisons: ModelComparison[] = [];
  let hasRegression = false;

  const protocols = Object.keys(currentModelResults);
  const benchmarks = Object.keys(currentModelResults[protocols[0]] || {});

  for (const protocol of protocols) {
    for (const benchmark of benchmarks) {
      const currentScore = currentModelResults[protocol]?.[benchmark];
      if (currentScore === undefined) {
        continue;
      }

      const baseline = calculateBaselineAverage(
        mainBranchResults,
        modelKey,
        protocol,
        benchmark
      );
      if (baseline === null) {
        continue;
      }

      const diff = ((currentScore - baseline) / baseline) * 100;
      const regression = diff < -2;

      if (regression) {
        hasRegression = true;
      }

      comparisons.push({
        protocol,
        benchmark,
        current: currentScore,
        baseline,
        diff,
        regression,
      });
    }
  }

  return { comparisons, hasRegression };
}

function calculateTrend(
  history: BenchmarkResult[],
  current: BenchmarkResult
): TrendResult {
  const mainBranchResults = history
    .filter((r) => r.branch === "main" && r.mode === current.mode)
    .slice(-5);

  if (mainBranchResults.length === 0) {
    return {
      hasBaseline: false,
      message: "No baseline data from main branch yet",
    };
  }

  const comparisons: Record<ModelKey, ModelComparison[]> = {
    qwen: [],
    glm: [],
    deepseek: [],
  };

  let hasRegression = false;

  for (const modelKey of MODEL_KEYS) {
    const currentModelResults = current.results[modelKey];
    if (!currentModelResults) {
      continue;
    }

    const result = processModelComparisons(
      modelKey,
      currentModelResults,
      mainBranchResults
    );
    comparisons[modelKey] = result.comparisons;
    if (result.hasRegression) {
      hasRegression = true;
    }
  }

  return {
    hasBaseline: true,
    baselineSampleSize: mainBranchResults.length,
    comparisons,
    hasRegression,
  };
}

function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDiff(diff: number): string {
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${diff.toFixed(1)}%`;
}

function getDiffEmoji(diff: number): string {
  if (diff < -2) {
    return "⚠️";
  }
  if (diff > 2) {
    return "✨";
  }
  return "";
}

function generateTableHeader(protocols: string[], hasNative: boolean): string {
  if (hasNative) {
    const otherProtocols = protocols.filter((p) => p !== "native");
    const header = `| Benchmark | native | ${otherProtocols.map((p) => `${p} | Δ`).join(" | ")} |\n`;
    const separator = `|-----------|--------|${otherProtocols.map(() => "--------|----").join("|")}|\n`;
    return header + separator;
  }
  const header = `| Benchmark | ${protocols.join(" | ")} |\n`;
  const separator = `|-----------|${protocols.map(() => "--------").join("|")}|\n`;
  return header + separator;
}

function generateTableRow(
  benchmark: string,
  protocols: string[],
  scores: Record<string, Record<string, number>>,
  hasNative: boolean
): string {
  if (hasNative) {
    const nativeScore = scores.native[benchmark];
    const cells = [formatPercentage(nativeScore)];

    for (const protocol of protocols.filter((p) => p !== "native")) {
      const score = scores[protocol][benchmark];
      const diff = ((score - nativeScore) / nativeScore) * 100;
      const emoji = getDiffEmoji(diff);
      cells.push(formatPercentage(score));
      cells.push(`${emoji} ${formatDiff(diff)}`);
    }

    return `| ${benchmark} | ${cells.join(" | ")} |\n`;
  }
  const cells = protocols.map((p) => formatPercentage(scores[p][benchmark]));
  return `| ${benchmark} | ${cells.join(" | ")} |\n`;
}

function generateCurrentResultsTable(
  modelKey: ModelKey,
  scores: Record<string, Record<string, number>>
): string {
  const protocols = Object.keys(scores);
  if (protocols.length === 0) {
    return "";
  }

  const benchmarks = Object.keys(scores[protocols[0]] || {});
  if (benchmarks.length === 0) {
    return "";
  }

  const hasNative = protocols.includes("native");

  let table = `#### ${MODEL_DISPLAY_NAMES[modelKey]}\n\n`;
  table += generateTableHeader(protocols, hasNative);

  for (const benchmark of benchmarks) {
    table += generateTableRow(benchmark, protocols, scores, hasNative);
  }

  table += "\n";
  return table;
}

function getComparisonEmoji(comp: ModelComparison): string {
  if (comp.regression) {
    return "⚠️";
  }
  if (comp.diff > 2) {
    return "✨";
  }
  return "";
}

function generateComparisonSection(
  comparisons: Record<ModelKey, ModelComparison[]>,
  baselineSampleSize: number
): string {
  let markdown = "### 📈 Comparison with Main Branch\n\n";
  markdown += `*Baseline: Average of last ${baselineSampleSize} results from main branch*\n\n`;

  for (const modelKey of MODEL_KEYS) {
    const modelComparisons = comparisons[modelKey];
    if (!modelComparisons || modelComparisons.length === 0) {
      continue;
    }

    markdown += `#### ${MODEL_DISPLAY_NAMES[modelKey]}\n\n`;
    markdown += "| Protocol | Benchmark | Current | Baseline | Δ |\n";
    markdown += "|----------|-----------|---------|----------|---|\n";

    for (const comp of modelComparisons) {
      const emoji = getComparisonEmoji(comp);
      markdown += `| ${comp.protocol} | ${comp.benchmark} | ${formatPercentage(comp.current)} | ${formatPercentage(comp.baseline)} | ${emoji} ${formatDiff(comp.diff)} |\n`;
    }

    markdown += "\n";
  }

  return markdown;
}

function generateMarkdownReport(
  current: BenchmarkResult,
  trend: TrendResult
): string {
  const modeEmoji = {
    fast: "⚡",
    full: "🔥",
  };

  let markdown = "## 📊 Regression Benchmark Results\n\n";

  markdown += `**Commit:** \`${current.commit.slice(0, 7)}\`\n`;
  markdown += `**Branch:** \`${current.branch}\`\n`;
  markdown += `**Mode:** ${modeEmoji[current.mode]} ${current.mode}\n`;
  markdown += `**Time:** ${new Date(current.timestamp).toLocaleString()}\n\n`;

  markdown += "### Current Results\n\n";

  for (const modelKey of MODEL_KEYS) {
    const scores = current.results[modelKey];
    if (scores && Object.keys(scores).length > 0) {
      markdown += generateCurrentResultsTable(modelKey, scores);
    }
  }

  if (trend.hasBaseline && trend.comparisons && trend.baselineSampleSize) {
    markdown += generateComparisonSection(
      trend.comparisons,
      trend.baselineSampleSize
    );

    if (trend.hasRegression) {
      markdown += "### ⚠️ Regression Detected\n\n";
      markdown +=
        "Some benchmarks show >2% performance drop compared to main branch baseline.\n";
      markdown += "Please review the changes to ensure this is expected.\n\n";
    } else {
      markdown += "### ✅ No Regression Detected\n\n";
      markdown +=
        "All benchmarks are within expected performance range (±2%) compared to main branch.\n\n";
    }
  } else {
    markdown += "### ℹ️ No Baseline Data\n\n";
    markdown +=
      "This is the first benchmark run or there's no data from main branch yet.\n";
    markdown += "Results will be used as baseline for future comparisons.\n\n";
  }

  markdown += "---\n";
  markdown +=
    "*Generated by [Claude Code](https://claude.com/claude-code) CI*\n";

  return markdown;
}

function main() {
  try {
    console.log("📊 Loading benchmark results...\n");

    const current = loadCurrentResult();
    const history = loadHistory();

    console.log(`Found ${history.length} historical results`);
    console.log(`Current commit: ${current.commit.slice(0, 7)}\n`);

    const trend = calculateTrend(history, current);

    const markdown = generateMarkdownReport(current, trend);

    const reportPath = path.join(process.cwd(), ".benchmark-results/report.md");
    fs.writeFileSync(reportPath, markdown);

    console.log(`✅ Report generated: ${reportPath}\n`);
    console.log("=".repeat(80));
    console.log(markdown);
    console.log("=".repeat(80));

    if (trend.hasBaseline && trend.hasRegression) {
      console.log("\n⚠️ Regression detected! See report for details.");
      process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    console.error("❌ Comparison failed:", error);
    process.exit(1);
  }
}

main();
