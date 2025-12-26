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
import { wrapLanguageModel } from "ai";

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

// Test model: Llama 3.1 70B
const llama31Model = friendli("meta-llama/Meta-Llama-3.1-70B-Instruct");
const wrappedModel = wrapLanguageModel({
  model: llama31Model,
  middleware: customMorphXmlMiddleware,
});

async function main() {
  console.log("Testing Llama 3.1 70B with morphXML...\n");

  const reporterEnv = process.env.EVAL_REPORTER as ReporterType | undefined;

  await evaluate({
    models: {
      "llama-3.1-70b": wrappedModel,
    },
    benchmarks: [
      bfclSimpleBenchmark,
      bfclMultipleBenchmark,
      bfclParallelBenchmark,
      bfclParallelMultipleBenchmark,
    ],
    reporter: reporterEnv ?? "console",
    temperature: 0.0,
    maxTokens: 256,
  });

  console.log("\nEvaluation complete!");
}

main();
