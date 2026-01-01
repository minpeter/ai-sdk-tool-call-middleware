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
  bfclParallelMultipleBenchmark,
  bfclSimpleBenchmark,
  evaluate,
} from "@ai-sdk-tool/eval";
import { createDiskCacheMiddleware } from "@ai-sdk-tool/middleware";
import { morphXmlToolMiddleware } from "@ai-sdk-tool/parser";
import {
  extractReasoningMiddleware,
  type LanguageModel,
  wrapLanguageModel,
} from "ai";

const MODEL_ID = "MiniMaxAI/MiniMax-M2";

const diskCacheMiddleware = createDiskCacheMiddleware({
  cacheDir: ".benchmark-results/cache",
});

// Get commit hash and branch
const commitHash = execSync("git rev-parse HEAD").toString().trim();
const shortHash = commitHash.slice(0, 7);
// GitHub Actions uses detached HEAD, so prefer environment variables
const branch =
  process.env.GITHUB_HEAD_REF || // PR source branch
  process.env.GITHUB_REF_NAME || // Push target branch
  execSync("git rev-parse --abbrev-ref HEAD").toString().trim();

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

const baseModel = friendli(MODEL_ID);

// Native tool calling (no middleware)
const nativeModel: LanguageModel = wrapLanguageModel({
  model: baseModel,
  middleware: [
    diskCacheMiddleware,
    extractReasoningMiddleware({ tagName: "think" }),
  ],
});

// morphXML protocol
const morphXmlModel: LanguageModel = wrapLanguageModel({
  model: baseModel,
  middleware: [
    diskCacheMiddleware,
    morphXmlToolMiddleware,
    extractReasoningMiddleware({ tagName: "think" }),
  ],
});

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

interface CaseResult {
  id: string;
  valid: boolean;
}

interface EvalResultWithCases {
  benchmark: string;
  result: {
    score: number;
    metrics: {
      case_results?: string;
    };
  };
}

const FAST_LIMIT = 5;

function extractFastScores(
  evalResults: EvalResultWithCases[]
): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const result of evalResults) {
    const caseResultsJson = result.result.metrics.case_results;
    if (!caseResultsJson) {
      scores[result.benchmark] = result.result.score;
      continue;
    }
    const caseResults: CaseResult[] = JSON.parse(caseResultsJson);
    const first5 = caseResults.slice(0, FAST_LIMIT);
    const correctCount = first5.filter((c) => c.valid).length;
    scores[result.benchmark] =
      first5.length > 0 ? correctCount / first5.length : 0;
  }
  return scores;
}

// All 4 BFCL benchmark categories
const allBenchmarks = [
  bfclSimpleBenchmark,
  bfclMultipleBenchmark,
  bfclParallelBenchmark,
  bfclParallelMultipleBenchmark,
];

async function runBenchmarks(): Promise<{
  fullResult: BenchmarkResult;
  fastResult: BenchmarkResult | null;
}> {
  const timestamp = new Date().toISOString();

  const mode = (process.env.BENCHMARK_MODE ||
    "fast") as BenchmarkResult["mode"];

  const benchmarkConfigs = {
    fast: {
      benchmarks: allBenchmarks,
      limit: 5,
      desc: "4 categories x 5 cases = 20 cases (x2 = 40 total), ~2min",
    },
    full: {
      benchmarks: allBenchmarks,
      limit: undefined,
      desc: "all 4 categories, all cases, ~15min",
    },
  };

  const config = benchmarkConfigs[mode];

  console.log(`Running in ${mode} mode (${config.desc})\n`);

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

  const nativeScores: Record<string, number> = {};
  for (const result of nativeResults) {
    nativeScores[result.benchmark] = result.result.score;
  }

  const morphXmlScores: Record<string, number> = {};
  for (const result of morphXmlResults) {
    morphXmlScores[result.benchmark] = result.result.score;
  }

  const fullResult: BenchmarkResult = {
    commit: commitHash,
    branch,
    timestamp,
    model: MODEL_ID,
    mode,
    results: {
      native: nativeScores,
      morphxml: morphXmlScores,
    },
  };

  let fastResult: BenchmarkResult | null = null;
  if (mode === "full") {
    const nativeFastScores = extractFastScores(
      nativeResults as EvalResultWithCases[]
    );
    const morphXmlFastScores = extractFastScores(
      morphXmlResults as EvalResultWithCases[]
    );
    fastResult = {
      commit: commitHash,
      branch,
      timestamp,
      model: MODEL_ID,
      mode: "fast",
      results: {
        native: nativeFastScores,
        morphxml: morphXmlFastScores,
      },
    };
  }

  return { fullResult, fastResult };
}

function saveResults(
  primaryResult: BenchmarkResult,
  fastResult: BenchmarkResult | null
) {
  const resultsDir = path.join(process.cwd(), ".benchmark-results");
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const filename = `benchmark-${shortHash}-${Date.now()}.json`;
  const filepath = path.join(resultsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(primaryResult, null, 2));

  console.log(`\n💾 Results saved to ${filepath}`);

  const historyFile = path.join(resultsDir, "history.jsonl");
  fs.appendFileSync(historyFile, `${JSON.stringify(primaryResult)}\n`);

  if (fastResult) {
    fs.appendFileSync(historyFile, `${JSON.stringify(fastResult)}\n`);
    console.log("📝 History updated with both full and fast entries");
  } else {
    console.log(`📝 History updated in ${historyFile}`);
  }
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
    const { fullResult, fastResult } = await runBenchmarks();
    await saveResults(fullResult, fastResult);
    await generateReport(fullResult);

    process.exit(0);
  } catch (error) {
    console.error("❌ Benchmark failed:", error);
    process.exit(1);
  }
}

main();
