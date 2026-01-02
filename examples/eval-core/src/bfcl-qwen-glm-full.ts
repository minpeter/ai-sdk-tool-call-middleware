import fs from "node:fs";
import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  bfclMultipleBenchmark,
  bfclParallelBenchmark,
  bfclParallelMultipleBenchmark,
  bfclSimpleBenchmark,
  evaluate,
  type ReporterType,
} from "@ai-sdk-tool/eval";
import { createToolMiddleware, xmlProtocol } from "@ai-sdk-tool/parser";
import {
  extractReasoningMiddleware,
  type LanguageModel,
  wrapLanguageModel,
} from "ai";

// Load system prompt from file
const systemPromptPath = path.join(
  __dirname,
  "Llama-4-Maverick-morphXml-bfcl.txt"
);
const systemPromptTemplate = fs.readFileSync(systemPromptPath, "utf-8");

// Create custom middleware with loaded system prompt
const customMorphXmlMiddleware = createToolMiddleware({
  protocol: xmlProtocol,
  placement: "last",
  toolSystemPromptTemplate(tools: string) {
    return systemPromptTemplate.replace(/\$\{tools\}/g, tools);
  },
});

// Friendli API
const friendli = createOpenAICompatible({
  name: "friendli.serverless",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

// Focus on Qwen3-30B-A3B and GLM-4.6 only (exclude Llama-4-Maverick and MiniMax-M2)
const models: Record<string, LanguageModel> = {
  "qwen3-30b-a3b": wrapLanguageModel({
    model: friendli("Qwen/Qwen3-30B-A3B"),
    middleware: [customMorphXmlMiddleware],
  }),
  "glm-4.6": wrapLanguageModel({
    model: friendli("zai-org/GLM-4.6"),
    middleware: [
      customMorphXmlMiddleware,
      extractReasoningMiddleware({ tagName: "think" }),
    ],
  }),
};

async function main() {
  console.log("🔍 Full BFCL Benchmark: Qwen3-30B-A3B vs GLM-4.6\n");
  console.log(
    "Testing all benchmark suites (Simple, Multiple, Parallel, Parallel-Multiple)\n"
  );

  const reporterEnv = process.env.EVAL_REPORTER as ReporterType | undefined;

  await evaluate({
    models,
    benchmarks: [
      bfclSimpleBenchmark,
      bfclMultipleBenchmark,
      bfclParallelBenchmark,
      bfclParallelMultipleBenchmark,
    ],
    reporter: reporterEnv ?? "console",
    temperature: 0.0,
    maxTokens: 512, // Increased for complex cases
  });

  console.log("\n✅ Evaluation complete!");
}

main();
