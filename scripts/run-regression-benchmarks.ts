#!/usr/bin/env tsx
/**
 * Regression Benchmark Runner
 *
 * Runs benchmarks comparing native tool calling vs morphXML vs yamlXML protocols
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
import {
  gemmaToolMiddleware,
  hermesToolMiddleware,
  morphXmlToolMiddleware,
  orchestratorToolMiddleware,
} from "@ai-sdk-tool/parser";
import {
  extractReasoningMiddleware,
  type LanguageModel,
  wrapLanguageModel,
} from "ai";

const MODEL_ID = "MiniMaxAI/MiniMax-M2";

const diskCacheMiddleware = createDiskCacheMiddleware({
  cacheDir: ".benchmark-results/cache",
});

const commitHash = execSync("git rev-parse HEAD").toString().trim();
const shortHash = commitHash.slice(0, 7);
const branch =
  process.env.GITHUB_HEAD_REF ||
  process.env.GITHUB_REF_NAME ||
  execSync("git rev-parse --abbrev-ref HEAD").toString().trim();

console.log(`🔍 Running regression benchmarks for commit ${shortHash}`);
console.log(`📦 Branch: ${branch}\n`);

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

const friendli = createOpenAICompatible({
  name: "friendli.serverless",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

const baseModel = friendli(MODEL_ID);

const nativeModel: LanguageModel = wrapLanguageModel({
  model: baseModel,
  middleware: [
    extractReasoningMiddleware({ tagName: "think" }),
    diskCacheMiddleware,
  ],
});

const morphXmlModel: LanguageModel = wrapLanguageModel({
  model: baseModel,
  middleware: [
    morphXmlToolMiddleware,
    extractReasoningMiddleware({ tagName: "think" }),
    diskCacheMiddleware,
  ],
});

const yamlXmlModel: LanguageModel = wrapLanguageModel({
  model: baseModel,
  middleware: [
    orchestratorToolMiddleware,
    extractReasoningMiddleware({ tagName: "think" }),
    diskCacheMiddleware,
  ],
});

const gemmaModel: LanguageModel = wrapLanguageModel({
  model: baseModel,
  middleware: [
    gemmaToolMiddleware,
    extractReasoningMiddleware({ tagName: "think" }),
    diskCacheMiddleware,
  ],
});

const hermesModel: LanguageModel = wrapLanguageModel({
  model: baseModel,
  middleware: [
    hermesToolMiddleware,
    extractReasoningMiddleware({ tagName: "think" }),
    diskCacheMiddleware,
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
    yamlxml: Record<string, number>;
    gemma: Record<string, number>;
    hermes: Record<string, number>;
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
      desc: "4 categories x 5 cases = 20 cases (x3 = 60 total), ~3min",
    },
    full: {
      benchmarks: allBenchmarks,
      limit: undefined,
      desc: "all 4 categories, all cases, ~20min",
    },
  };

  const config = benchmarkConfigs[mode];

  console.log(`Running in ${mode} mode (${config.desc})\n`);

  if (config.limit) {
    process.env.BFCL_LIMIT = config.limit.toString();
  } else {
    process.env.BFCL_LIMIT = undefined;
  }

  console.log("Running native tool calling benchmarks...\n");
  const nativeResults = await evaluate({
    models: { native: nativeModel },
    benchmarks: config.benchmarks,
    reporter: "console.summary",
    temperature: 0.0,
    maxTokens: 512,
  });

  console.log("\nRunning morphXML protocol benchmarks...\n");
  const morphXmlResults = await evaluate({
    models: { morphxml: morphXmlModel },
    benchmarks: config.benchmarks,
    reporter: "console.summary",
    temperature: 0.0,
    maxTokens: 512,
  });

  console.log("\nRunning YAML-XML protocol benchmarks...\n");
  const yamlXmlResults = await evaluate({
    models: { yamlxml: yamlXmlModel },
    benchmarks: config.benchmarks,
    reporter: "console.summary",
    temperature: 0.0,
    maxTokens: 512,
  });

  console.log("\nRunning Gemma protocol benchmarks...\n");
  const gemmaResults = await evaluate({
    models: { gemma: gemmaModel },
    benchmarks: config.benchmarks,
    reporter: "console.summary",
    temperature: 0.0,
    maxTokens: 512,
  });

  console.log("\nRunning Hermes protocol benchmarks...\n");
  const hermesResults = await evaluate({
    models: { hermes: hermesModel },
    benchmarks: config.benchmarks,
    reporter: "console.summary",
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

  const yamlXmlScores: Record<string, number> = {};
  for (const result of yamlXmlResults) {
    yamlXmlScores[result.benchmark] = result.result.score;
  }

  const gemmaScores: Record<string, number> = {};
  for (const result of gemmaResults) {
    gemmaScores[result.benchmark] = result.result.score;
  }

  const hermesScores: Record<string, number> = {};
  for (const result of hermesResults) {
    hermesScores[result.benchmark] = result.result.score;
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
      yamlxml: yamlXmlScores,
      gemma: gemmaScores,
      hermes: hermesScores,
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
    const yamlXmlFastScores = extractFastScores(
      yamlXmlResults as EvalResultWithCases[]
    );
    const gemmaFastScores = extractFastScores(
      gemmaResults as EvalResultWithCases[]
    );
    const hermesFastScores = extractFastScores(
      hermesResults as EvalResultWithCases[]
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
        yamlxml: yamlXmlFastScores,
        gemma: gemmaFastScores,
        hermes: hermesFastScores,
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

  if (process.env.CI) {
    const historyFile = path.join(resultsDir, "history.jsonl");
    fs.appendFileSync(historyFile, `${JSON.stringify(primaryResult)}\n`);

    if (fastResult) {
      fs.appendFileSync(historyFile, `${JSON.stringify(fastResult)}\n`);
      console.log("📝 History updated with both full and fast entries");
    } else {
      console.log(`📝 History updated in ${historyFile}`);
    }
  } else {
    console.log("⏭️  Skipping history.jsonl update (local run)");
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

  console.log(
    "| Benchmark              | Native  | morphXML | YAML-XML | Gemma   | Hermes  |"
  );
  console.log(
    "|------------------------|---------|----------|----------|---------|---------|"
  );

  const benchmarks = Object.keys(results.results.native);
  for (const benchmark of benchmarks) {
    const nativeScore = results.results.native[benchmark];
    const morphxmlScore = results.results.morphxml[benchmark];
    const yamlxmlScore = results.results.yamlxml[benchmark];
    const gemmaScore = results.results.gemma[benchmark];
    const hermesScore = results.results.hermes[benchmark];

    console.log(
      `| ${benchmark.padEnd(22)} | ${(nativeScore * 100).toFixed(1).padStart(5)}%  | ${(morphxmlScore * 100).toFixed(1).padStart(6)}%  | ${(yamlxmlScore * 100).toFixed(1).padStart(6)}%  | ${(gemmaScore * 100).toFixed(1).padStart(5)}%  | ${(hermesScore * 100).toFixed(1).padStart(5)}%  |`
    );
  }

  const nativeAvg =
    Object.values(results.results.native).reduce((a, b) => a + b, 0) /
    benchmarks.length;
  const morphxmlAvg =
    Object.values(results.results.morphxml).reduce((a, b) => a + b, 0) /
    benchmarks.length;
  const yamlxmlAvg =
    Object.values(results.results.yamlxml).reduce((a, b) => a + b, 0) /
    benchmarks.length;
  const gemmaAvg =
    Object.values(results.results.gemma).reduce((a, b) => a + b, 0) /
    benchmarks.length;
  const hermesAvg =
    Object.values(results.results.hermes).reduce((a, b) => a + b, 0) /
    benchmarks.length;

  console.log(
    "|------------------------|---------|----------|----------|---------|---------|"
  );
  console.log(
    `| ${"AVERAGE".padEnd(22)} | ${(nativeAvg * 100).toFixed(1).padStart(5)}%  | ${(morphxmlAvg * 100).toFixed(1).padStart(6)}%  | ${(yamlxmlAvg * 100).toFixed(1).padStart(6)}%  | ${(gemmaAvg * 100).toFixed(1).padStart(5)}%  | ${(hermesAvg * 100).toFixed(1).padStart(5)}%  |`
  );

  console.log(`\n${"-".repeat(80)}`);
  console.log("DIFFERENCE FROM NATIVE:\n");

  const morphDiff =
    nativeAvg > 0 ? ((morphxmlAvg - nativeAvg) / nativeAvg) * 100 : 0;
  const yamlDiff =
    nativeAvg > 0 ? ((yamlxmlAvg - nativeAvg) / nativeAvg) * 100 : 0;
  const gemmaDiff =
    nativeAvg > 0 ? ((gemmaAvg - nativeAvg) / nativeAvg) * 100 : 0;
  const hermesDiff =
    nativeAvg > 0 ? ((hermesAvg - nativeAvg) / nativeAvg) * 100 : 0;

  console.log(
    `  morphXML: ${morphDiff >= 0 ? "+" : ""}${morphDiff.toFixed(1)}%`
  );
  console.log(`  YAML-XML: ${yamlDiff >= 0 ? "+" : ""}${yamlDiff.toFixed(1)}%`);
  console.log(
    `  Gemma:    ${gemmaDiff >= 0 ? "+" : ""}${gemmaDiff.toFixed(1)}%`
  );
  console.log(
    `  Hermes:   ${hermesDiff >= 0 ? "+" : ""}${hermesDiff.toFixed(1)}%`
  );
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
