#!/usr/bin/env tsx
/**
 * Benchmark Comparison Script
 *
 * Compares current benchmark results with historical data
 * and generates a markdown report for PR comments.
 */

import fs from "node:fs";
import path from "node:path";

interface BenchmarkResult {
  commit: string;
  branch: string;
  timestamp: string;
  model: string;
  mode: "fast" | "full";
  results: {
    native: Record<string, number>;
    morphxml: Record<string, number>;
  };
}

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

function calculateTrend(history: BenchmarkResult[], current: BenchmarkResult) {
  // Get last 5 results from main branch with SAME MODE and SAME MODEL
  const mainBranchResults = history
    .filter(
      (r) =>
        r.branch === "main" &&
        r.mode === current.mode &&
        r.model === current.model
    )
    .slice(-5);

  if (mainBranchResults.length === 0) {
    return {
      hasBaseline: false,
      message: "No baseline data from main branch yet",
    };
  }

  // Calculate average scores from main branch
  const mainAvgNative: Record<string, number> = {};
  const mainAvgMorphxml: Record<string, number> = {};

  const benchmarks = Object.keys(mainBranchResults[0].results.native);
  for (const benchmark of benchmarks) {
    let nativeSum = 0;
    let morphxmlSum = 0;
    for (const result of mainBranchResults) {
      nativeSum += result.results.native[benchmark] || 0;
      morphxmlSum += result.results.morphxml[benchmark] || 0;
    }
    mainAvgNative[benchmark] = nativeSum / mainBranchResults.length;
    mainAvgMorphxml[benchmark] = morphxmlSum / mainBranchResults.length;
  }

  // Compare current with main average
  const comparisons: Array<{
    benchmark: string;
    currentNative: number;
    currentMorphxml: number;
    baselineNative: number;
    baselineMorphxml: number;
    nativeDiff: number;
    morphxmlDiff: number;
    regression: boolean;
  }> = [];

  for (const benchmark of benchmarks) {
    const currentNative = current.results.native[benchmark];
    const currentMorphxml = current.results.morphxml[benchmark];
    const baselineNative = mainAvgNative[benchmark];
    const baselineMorphxml = mainAvgMorphxml[benchmark];

    const nativeDiff =
      ((currentNative - baselineNative) / baselineNative) * 100;
    const morphxmlDiff =
      ((currentMorphxml - baselineMorphxml) / baselineMorphxml) * 100;

    // Consider >2% drop as regression
    const regression = nativeDiff < -2 || morphxmlDiff < -2;

    comparisons.push({
      benchmark,
      currentNative,
      currentMorphxml,
      baselineNative,
      baselineMorphxml,
      nativeDiff,
      morphxmlDiff,
      regression,
    });
  }

  return {
    hasBaseline: true,
    baselineSampleSize: mainBranchResults.length,
    comparisons,
    hasRegression: comparisons.some((c) => c.regression),
  };
}

function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDiff(diff: number): string {
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${diff.toFixed(1)}%`;
}

function generateComparisonTable(
  comparisons: Array<{
    benchmark: string;
    currentNative: number;
    currentMorphxml: number;
    baselineNative: number;
    baselineMorphxml: number;
    nativeDiff: number;
    morphxmlDiff: number;
  }>
): string {
  let table =
    "| Benchmark | Current Native | Baseline Native | Δ Native | Current morphXML | Baseline morphXML | Δ morphXML |\n";
  table +=
    "|-----------|----------------|-----------------|----------|------------------|-------------------|------------|\n";

  for (const comp of comparisons) {
    let nativeEmoji = "";
    if (comp.nativeDiff < -2) {
      nativeEmoji = "⚠️";
    } else if (comp.nativeDiff > 2) {
      nativeEmoji = "✨";
    }

    let morphxmlEmoji = "";
    if (comp.morphxmlDiff < -2) {
      morphxmlEmoji = "⚠️";
    } else if (comp.morphxmlDiff > 2) {
      morphxmlEmoji = "✨";
    }

    table += `| ${comp.benchmark} | ${formatPercentage(comp.currentNative)} | ${formatPercentage(comp.baselineNative)} | ${nativeEmoji} ${formatDiff(comp.nativeDiff)} | ${formatPercentage(comp.currentMorphxml)} | ${formatPercentage(comp.baselineMorphxml)} | ${morphxmlEmoji} ${formatDiff(comp.morphxmlDiff)} |\n`;
  }

  return table;
}

function generateMarkdownReport(
  current: BenchmarkResult,
  trend: ReturnType<typeof calculateTrend>
): string {
  const modeEmoji = {
    fast: "⚡",
    full: "🔥",
  };

  let markdown = "## 📊 Regression Benchmark Results\n\n";

  markdown += `**Commit:** \`${current.commit.slice(0, 7)}\`\n`;
  markdown += `**Branch:** \`${current.branch}\`\n`;
  markdown += `**Model:** ${current.model}\n`;
  markdown += `**Mode:** ${modeEmoji[current.mode]} ${current.mode}\n`;
  markdown += `**Time:** ${new Date(current.timestamp).toLocaleString()}\n\n`;

  markdown += "### Current Results\n\n";
  markdown += "| Benchmark | Native | morphXML | Δ |\n";
  markdown += "|-----------|--------|----------|---|\n";

  const benchmarks = Object.keys(current.results.native);
  for (const benchmark of benchmarks) {
    const nativeScore = current.results.native[benchmark];
    const morphxmlScore = current.results.morphxml[benchmark];
    const diff = ((morphxmlScore - nativeScore) / nativeScore) * 100;

    markdown += `| ${benchmark} | ${formatPercentage(nativeScore)} | ${formatPercentage(morphxmlScore)} | ${formatDiff(diff)} |\n`;
  }

  // Calculate averages
  const nativeAvg =
    Object.values(current.results.native).reduce((a, b) => a + b, 0) /
    benchmarks.length;
  const morphxmlAvg =
    Object.values(current.results.morphxml).reduce((a, b) => a + b, 0) /
    benchmarks.length;
  const avgDiff = ((morphxmlAvg - nativeAvg) / nativeAvg) * 100;

  markdown += `| **Average** | **${formatPercentage(nativeAvg)}** | **${formatPercentage(morphxmlAvg)}** | **${formatDiff(avgDiff)}** |\n\n`;

  // Comparison with main branch
  if (trend.hasBaseline && "comparisons" in trend) {
    markdown += "### 📈 Comparison with Main Branch\n\n";
    markdown += `*Baseline: Average of last ${trend.baselineSampleSize} results from main branch*\n\n`;

    markdown += generateComparisonTable(trend.comparisons);
    markdown += "\n";

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

    // Save to file for CI
    const reportPath = path.join(process.cwd(), ".benchmark-results/report.md");
    fs.writeFileSync(reportPath, markdown);

    console.log(`✅ Report generated: ${reportPath}\n`);
    console.log("=".repeat(80));
    console.log(markdown);
    console.log("=".repeat(80));

    // Exit with error code if regression detected
    if (trend.hasBaseline && "hasRegression" in trend && trend.hasRegression) {
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
