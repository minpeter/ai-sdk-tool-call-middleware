#!/usr/bin/env tsx

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
  hermesToolMiddleware,
  xmlToolMiddleware,
  yamlToolMiddleware,
} from "@ai-sdk-tool/parser";
import {
  extractReasoningMiddleware,
  type LanguageModel,
  type LanguageModelMiddleware,
  wrapLanguageModel,
} from "ai";

const QWEN_MODEL = "Qwen/Qwen3-235B-A22B-Instruct-2507";
const GLM_MODEL = "zai-org/GLM-4.6";
const DEEPSEEK_MODEL = "deepseek-ai/DeepSeek-R1-0528";

const diskCacheMiddleware = createDiskCacheMiddleware({
  cacheDir: ".benchmark-results/cache",
});

const commitHash = execSync("git rev-parse HEAD").toString().trim();
const shortHash = commitHash.slice(0, 7);

function getBranch(): string {
  if (process.env.PR_BRANCH) {
    return process.env.PR_BRANCH;
  }
  if (process.env.GITHUB_HEAD_REF) {
    return process.env.GITHUB_HEAD_REF;
  }
  if (process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }
  return execSync("git rev-parse --abbrev-ref HEAD").toString().trim();
}

const branch = getBranch();

console.log(
  `🔍 Running specialized regression benchmarks for commit ${shortHash}`
);
console.log(`📦 Branch: ${branch}\n`);

if (!process.env.FRIENDLI_TOKEN) {
  console.error("❌ ERROR: FRIENDLI_TOKEN environment variable is not set");
  process.exit(1);
}

const friendli = createOpenAICompatible({
  name: "friendli.serverless",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

type MiddlewareArray = LanguageModelMiddleware[];

function createWrappedModel(
  baseModel: LanguageModel,
  middleware: MiddlewareArray = []
): LanguageModel {
  return wrapLanguageModel({
    model: baseModel,
    middleware: [
      ...middleware,
      extractReasoningMiddleware({ tagName: "think" }),
      diskCacheMiddleware,
    ],
  });
}

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

const allBenchmarks = [
  bfclSimpleBenchmark,
  bfclMultipleBenchmark,
  bfclParallelBenchmark,
  bfclParallelMultipleBenchmark,
];

async function runModelBenchmark(
  modelId: string,
  configs: Record<string, LanguageModel>,
  benchmarks: typeof allBenchmarks
): Promise<Record<string, Record<string, number>>> {
  console.log(`\n🚀 Testing ${modelId}...`);
  const results = await evaluate({
    models: configs,
    benchmarks,
    reporter: "console.summary",
    temperature: 0.0,
    maxTokens: 4096,
  });

  const scores: Record<string, Record<string, number>> = {};
  for (const name of Object.keys(configs)) {
    scores[name] = {};
  }

  for (const result of results) {
    const modelName = result.modelKey;
    if (modelName && scores[modelName]) {
      scores[modelName][result.benchmark] = result.result.score;
    }
  }

  return scores;
}

async function main() {
  const timestamp = new Date().toISOString();
  const mode = (process.env.BENCHMARK_MODE || "fast") as "fast" | "full";
  const limit = mode === "fast" ? 5 : undefined;

  if (limit) {
    process.env.BFCL_LIMIT = limit.toString();
  } else {
    process.env.BFCL_LIMIT = undefined;
  }

  try {
    // 1. Qwen Benchmarks
    const qwenScores = await runModelBenchmark(
      QWEN_MODEL,
      {
        native: createWrappedModel(friendli(QWEN_MODEL)),
        hermes: createWrappedModel(friendli(QWEN_MODEL), [
          hermesToolMiddleware,
        ]),
      },
      allBenchmarks
    );

    // 2. GLM Benchmarks
    const glmScores = await runModelBenchmark(
      GLM_MODEL,
      {
        native: createWrappedModel(friendli(GLM_MODEL)),
        morphxml: createWrappedModel(friendli(GLM_MODEL), [xmlToolMiddleware]),
        yamlxml: createWrappedModel(friendli(GLM_MODEL), [yamlToolMiddleware]),
      },
      allBenchmarks
    );

    // 3. DeepSeek Benchmarks
    const deepseekScores = await runModelBenchmark(
      DEEPSEEK_MODEL,
      {
        morphxml: createWrappedModel(friendli(DEEPSEEK_MODEL), [
          xmlToolMiddleware,
        ]),
        yamlxml: createWrappedModel(friendli(DEEPSEEK_MODEL), [
          yamlToolMiddleware,
        ]),
        hermes: createWrappedModel(friendli(DEEPSEEK_MODEL), [
          hermesToolMiddleware,
        ]),
      },
      allBenchmarks
    );

    const fullResult: BenchmarkResult = {
      commit: commitHash,
      branch,
      timestamp,
      mode,
      results: {
        qwen: qwenScores,
        glm: glmScores,
        deepseek: deepseekScores,
      },
    };

    const resultsDir = path.join(process.cwd(), ".benchmark-results");
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    const filename = `benchmark-${shortHash}-${Date.now()}.json`;
    fs.writeFileSync(
      path.join(resultsDir, filename),
      JSON.stringify(fullResult, null, 2)
    );

    if (process.env.CI) {
      fs.appendFileSync(
        path.join(resultsDir, "history.jsonl"),
        `${JSON.stringify(fullResult)}\n`
      );
    }

    console.log(`\n${"═".repeat(80)}`);
    console.log("📊 SPECIALIZED REGRESSION TEST REPORT");
    console.log("═".repeat(80));

    const colors = {
      green: "\x1b[32m",
      red: "\x1b[31m",
      gray: "\x1b[90m",
      reset: "\x1b[0m",
    };

    const printTable = (
      title: string,
      scores: Record<string, Record<string, number>>
    ) => {
      console.log(`\n### ${title}`);
      const protocols = Object.keys(scores);
      const benchmarks = Object.keys(scores[protocols[0]] || {});
      if (benchmarks.length === 0) {
        return;
      }

      const hasNative = protocols.includes("native");
      const colWidths = {
        benchmark: 23,
        protocol: 10,
        diff: 8,
      };

      const headers = hasNative
        ? protocols.flatMap((p) => (p === "native" ? [p] : [p, "Δ"]))
        : protocols;

      const headerWidths = hasNative
        ? protocols.flatMap((p) =>
            p === "native"
              ? [colWidths.protocol]
              : [colWidths.protocol, colWidths.diff]
          )
        : protocols.map(() => colWidths.protocol);

      console.log(
        `┌${"─".repeat(colWidths.benchmark + 2)}┬${headerWidths.map((w) => "─".repeat(w + 2)).join("┬")}┐`
      );
      console.log(
        `│ ${"Benchmark".padEnd(colWidths.benchmark)} │ ${headers.map((h, i) => h.padEnd(headerWidths[i])).join(" │ ")} │`
      );
      console.log(
        `├${"─".repeat(colWidths.benchmark + 2)}┼${headerWidths.map((w) => "─".repeat(w + 2)).join("┼")}┤`
      );

      for (const b of benchmarks) {
        const nativeScore = hasNative ? scores.native[b] : 0;
        const cells = hasNative
          ? protocols.flatMap((p) => {
              const score = `${(scores[p][b] * 100).toFixed(1)}%`.padStart(
                colWidths.protocol
              );
              if (p === "native") {
                return [score];
              }
              const diff = scores[p][b] - nativeScore;
              const diffNum = (diff * 100).toFixed(0);
              let diffStr: string;
              if (diff > 0) {
                diffStr = `${colors.green}+${diffNum}%${colors.reset}`.padStart(
                  colWidths.diff + colors.green.length + colors.reset.length
                );
              } else if (diff < 0) {
                diffStr = `${colors.red}${diffNum}%${colors.reset}`.padStart(
                  colWidths.diff + colors.red.length + colors.reset.length
                );
              } else {
                diffStr = `${colors.gray}0%${colors.reset}`.padStart(
                  colWidths.diff + colors.gray.length + colors.reset.length
                );
              }
              return [score, diffStr];
            })
          : protocols.map((p) =>
              `${(scores[p][b] * 100).toFixed(1)}%`.padStart(colWidths.protocol)
            );
        console.log(
          `│ ${b.padEnd(colWidths.benchmark)} │ ${cells.join(" │ ")} │`
        );
      }

      console.log(
        `└${"─".repeat(colWidths.benchmark + 2)}┴${headerWidths.map((w) => "─".repeat(w + 2)).join("┴")}┘`
      );
    };

    printTable(`QWEN (${QWEN_MODEL})`, qwenScores);
    printTable(`GLM (${GLM_MODEL})`, glmScores);
    printTable(`DEEPSEEK (${DEEPSEEK_MODEL})`, deepseekScores);

    process.exit(0);
  } catch (error) {
    console.error("❌ Benchmark failed:", error);
    process.exit(1);
  }
}

main();
