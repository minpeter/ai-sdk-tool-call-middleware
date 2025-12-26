import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  bfclMultipleBenchmark,
  bfclParallelBenchmark,
  bfclParallelMultipleBenchmark,
  bfclSimpleBenchmark,
  evaluate,
  type ReporterType,
} from "@ai-sdk-tool/eval";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";

// Friendli API
const friendli = createOpenAICompatible({
  name: "friendli.serverless",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

// MiniMax-M2 with native tool calling + reasoning extraction
// Based on 01-stream-reasoning-tool-call.ts pattern
const minimaxNative = wrapLanguageModel({
  model: friendli("MiniMaxAI/MiniMax-M2"),
  middleware: [
    // MiniMax-M2 uses "reasoning_content" field natively
    // Just extract it without parsing XML
    extractReasoningMiddleware({ tagName: "reasoning_content" }),
  ],
});

async function main() {
  console.log("🔍 Testing MiniMax-M2 with Native Tool Calling\n");

  const reporterEnv = process.env.EVAL_REPORTER as ReporterType | undefined;

  await evaluate({
    models: {
      "minimax-m2-native": minimaxNative,
    },
    benchmarks: [
      bfclSimpleBenchmark,
      bfclMultipleBenchmark,
      bfclParallelBenchmark,
      bfclParallelMultipleBenchmark,
    ],
    reporter: reporterEnv ?? "console",
    temperature: 0.0,
    maxTokens: 512,
  });

  console.log("\nEvaluation complete!");
}

main();
