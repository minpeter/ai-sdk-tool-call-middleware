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
import { createToolMiddleware, morphXmlProtocol } from "@ai-sdk-tool/parser";
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";

// Load system prompt from file
const systemPromptPath = path.join(
  __dirname,
  "Llama-4-Maverick-morphXml-bfcl.txt"
);
const systemPromptTemplate = fs.readFileSync(systemPromptPath, "utf-8");

// Create custom middleware with loaded system prompt
const customMorphXmlMiddleware = createToolMiddleware({
  protocol: morphXmlProtocol,
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

// GLM-4.6 with morphXML and reasoning extraction
const glm = wrapLanguageModel({
  model: friendli("zai-org/GLM-4.6"),
  middleware: [
    customMorphXmlMiddleware,
    extractReasoningMiddleware({ tagName: "think" }),
  ],
});

async function main() {
  console.log("🔍 Full BFCL Benchmark: GLM-4.6 (ALL CASES)\n");
  console.log("Testing all benchmark suites with DEBUG output enabled");
  console.log(
    "This will help identify if failures are parser or model issues\n"
  );

  const reporterEnv = process.env.EVAL_REPORTER as ReporterType | undefined;

  await evaluate({
    models: {
      "glm-4.6": glm,
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

  console.log("\n✅ Full BFCL evaluation complete!");
}

main();
