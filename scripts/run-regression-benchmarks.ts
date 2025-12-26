#!/usr/bin/env tsx
/**
 * Regression Benchmark Runner
 *
 * Runs benchmarks comparing native tool calling vs morphXML protocol
 * with the same model, saves results with commit hash for historical comparison.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  bfclMultipleBenchmark,
  bfclParallelBenchmark,
  bfclSimpleBenchmark,
  evaluate,
} from "@ai-sdk-tool/eval";
import { createToolMiddleware, morphXmlProtocol } from "@ai-sdk-tool/parser";
import {
  extractReasoningMiddleware,
  type LanguageModel,
  wrapLanguageModel,
} from "ai";

// Get commit hash and branch
const commitHash = execSync("git rev-parse HEAD").toString().trim();
const shortHash = commitHash.slice(0, 7);
const branch = execSync("git rev-parse --abbrev-ref HEAD").toString().trim();

console.log(`🔍 Running regression benchmarks for commit ${shortHash}`);
console.log(`📦 Branch: ${branch}\n`);

// Check for API token
if (!process.env.FRIENDLI_TOKEN) {
  console.error("❌ ERROR: FRIENDLI_TOKEN environment variable is not set");
  console.error("");
  console.error("Please set the FRIENDLI_TOKEN environment variable:");
  console.error("  export FRIENDLI_TOKEN=your_api_token_here");
  console.error("");
  console.error("Or add it to GitHub Secrets:");
  console.error(
    "  Settings > Secrets and variables > Actions > New repository secret"
  );
  console.error("  Name: FRIENDLI_TOKEN");
  console.error("");
  process.exit(1);
}

// Setup model provider (using a commonly available model)
const friendli = createOpenAICompatible({
  name: "friendli.serverless",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

// Use GLM-4.6 as baseline model for regression testing
const baseModel = friendli("zai-org/GLM-4.6");

// Native tool calling (no middleware)
const nativeModel: LanguageModel = wrapLanguageModel({
  model: baseModel,
  middleware: [extractReasoningMiddleware({ tagName: "think" })],
});

// morphXML protocol
const morphXmlModel: LanguageModel = wrapLanguageModel({
  model: baseModel,
  middleware: [
    createToolMiddleware({
      protocol: morphXmlProtocol,
      placement: "last",
    }),
    extractReasoningMiddleware({ tagName: "think" }),
  ],
});

interface BenchmarkResult {
  commit: string;
  branch: string;
  timestamp: string;
  model: string;
  mode: "ultra-quick" | "quick" | "full";
  results: {
    native: Record<string, number>;
    morphxml: Record<string, number>;
  };
}

async function runBenchmarks(): Promise<BenchmarkResult> {
  const timestamp = new Date().toISOString();

  // 환경변수로 모드 결정 (기본값: quick)
  const mode = (process.env.BENCHMARK_MODE ||
    "quick") as BenchmarkResult["mode"];

  // 모드별 벤치마크 설정
  const benchmarkConfigs = {
    "ultra-quick": {
      benchmarks: [bfclSimpleBenchmark],
      limit: 50,
      desc: "50 cases, ~2min",
    },
    quick: {
      benchmarks: [bfclSimpleBenchmark],
      limit: 100,
      desc: "100 cases, ~5min",
    },
    full: {
      benchmarks: [
        bfclSimpleBenchmark,
        bfclMultipleBenchmark,
        bfclParallelBenchmark,
      ],
      limit: undefined,
      desc: "all cases, ~15min",
    },
  };

  const config = benchmarkConfigs[mode];

  console.log(`Running in ${mode} mode (${config.desc})\n`);

  // BFCL_LIMIT 환경변수 설정 (ultra-quick/quick인 경우)
  if (config.limit) {
    process.env.BFCL_LIMIT = config.limit.toString();
  }

  console.log("Running native tool calling benchmarks...\n");
  const nativeResults = await evaluate({
    models: { native: nativeModel },
    benchmarks: config.benchmarks,
    reporter: "console",
    temperature: 0.0,
    maxTokens: 512,
  });

  console.log("\nRunning morphXML protocol benchmarks...\n");
  const morphXmlResults = await evaluate({
    models: { morphxml: morphXmlModel },
    benchmarks: config.benchmarks,
    reporter: "console",
    temperature: 0.0,
    maxTokens: 512,
  });

  // Extract scores
  const nativeScores: Record<string, number> = {};
  for (const result of nativeResults) {
    nativeScores[result.benchmark] = result.result.score;
  }

  const morphXmlScores: Record<string, number> = {};
  for (const result of morphXmlResults) {
    morphXmlScores[result.benchmark] = result.result.score;
  }

  return {
    commit: commitHash,
    branch,
    timestamp,
    model: "zai-org/GLM-4.6",
    mode,
    results: {
      native: nativeScores,
      morphxml: morphXmlScores,
    },
  };
}

function saveResults(results: BenchmarkResult) {
  const resultsDir = path.join(process.cwd(), ".benchmark-results");
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  // Save individual result file
  const filename = `benchmark-${shortHash}-${Date.now()}.json`;
  const filepath = path.join(resultsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(results, null, 2));

  console.log(`\n💾 Results saved to ${filepath}`);

  // Update history file
  const historyFile = path.join(resultsDir, "history.jsonl");
  fs.appendFileSync(historyFile, `${JSON.stringify(results)}\n`);

  console.log(`📝 History updated in ${historyFile}`);
}

function generateReport(results: BenchmarkResult) {
  console.log(`\n${"=".repeat(80)}`);
  console.log("📊 REGRESSION TEST REPORT");
  console.log("=".repeat(80));
  console.log(`Commit: ${results.commit.slice(0, 7)}`);
  console.log(`Branch: ${results.branch}`);
  console.log(`Model: ${results.model}`);
  console.log(`Time: ${new Date(results.timestamp).toLocaleString()}`);
  console.log(`\n${"-".repeat(80)}`);
  console.log("BENCHMARK RESULTS\n");

  const benchmarks = Object.keys(results.results.native);
  for (const benchmark of benchmarks) {
    const nativeScore = results.results.native[benchmark];
    const morphxmlScore = results.results.morphxml[benchmark];
    const diff = ((morphxmlScore - nativeScore) / nativeScore) * 100;

    console.log(`${benchmark}:`);
    console.log(`  Native:     ${(nativeScore * 100).toFixed(1)}%`);
    console.log(`  morphXML:   ${(morphxmlScore * 100).toFixed(1)}%`);
    console.log(`  Difference: ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}%`);
    console.log();
  }

  // Calculate averages
  const nativeAvg =
    Object.values(results.results.native).reduce((a, b) => a + b, 0) /
    benchmarks.length;
  const morphxmlAvg =
    Object.values(results.results.morphxml).reduce((a, b) => a + b, 0) /
    benchmarks.length;
  const avgDiff = ((morphxmlAvg - nativeAvg) / nativeAvg) * 100;

  console.log("-".repeat(80));
  console.log("OVERALL AVERAGE:\n");
  console.log(`  Native:     ${(nativeAvg * 100).toFixed(1)}%`);
  console.log(`  morphXML:   ${(morphxmlAvg * 100).toFixed(1)}%`);
  console.log(`  Difference: ${avgDiff >= 0 ? "+" : ""}${avgDiff.toFixed(1)}%`);
  console.log(`${"=".repeat(80)}\n`);
}

async function main() {
  try {
    const results = await runBenchmarks();
    await saveResults(results);
    await generateReport(results);

    process.exit(0);
  } catch (error) {
    console.error("❌ Benchmark failed:", error);
    process.exit(1);
  }
}

main();
