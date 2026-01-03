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
  return `${(value * 100).toFixed(1)}%`.padStart(10);
}

function formatDiff(diff: number): string {
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${Math.round(diff)}%`.padStart(8);
}

function generateMarkdownTable(
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

  let table = `### ${MODEL_DISPLAY_NAMES[modelKey]}\n\n`;

  // Build header
  let header = "| Benchmark |";
  let separator = "|-----------|";
  if (hasNative) {
    header += " native |";
    separator += "--------|";
    for (const p of protocols.filter((p) => p !== "native")) {
      header += ` ${p} | Δ |`;
      separator += "--------|--------|";
    }
  } else {
    for (const p of protocols) {
      header += ` ${p} |`;
      separator += "--------|";
    }
  }
  table += `${header}\n${separator}\n`;

  // Build data rows
  for (const benchmark of benchmarks) {
    let row = `| ${benchmark} |`;
    if (hasNative) {
      const nativeScore = scores.native[benchmark];
      row += ` ${formatPercentage(nativeScore)} |`;
      for (const protocol of protocols.filter((p) => p !== "native")) {
        const score = scores[protocol][benchmark];
        const diff = ((score - nativeScore) / nativeScore) * 100;
        row += ` ${formatPercentage(score)} | ${formatDiff(diff)} |`;
      }
    } else {
      for (const protocol of protocols) {
        row += ` ${formatPercentage(scores[protocol][benchmark])} |`;
      }
    }
    table += `${row}\n`;
  }

  table += "\n";
  return table;
}

function generateMarkdownReport(
  current: BenchmarkResult,
  trend: TrendResult
): string {
  const modeEmoji = { fast: "⚡", full: "🔥" };

  let markdown = "## 📊 Regression Benchmark Results\n\n";
  markdown += `\`${current.commit.slice(0, 7)}\` on \`${current.branch}\` ${modeEmoji[current.mode]}\n\n`;

  for (const modelKey of MODEL_KEYS) {
    const scores = current.results[modelKey];
    if (scores && Object.keys(scores).length > 0) {
      markdown += generateMarkdownTable(modelKey, scores);
    }
  }

  if (trend.hasBaseline && trend.hasRegression) {
    markdown += "⚠️ **Regression detected** (>2% drop vs main)\n";
  } else if (trend.hasBaseline) {
    markdown += "✅ No regression\n";
  }

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
