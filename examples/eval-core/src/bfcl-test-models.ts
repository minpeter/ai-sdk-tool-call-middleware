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
import {
  createToolMiddleware,
  type TCMToolDefinition,
  xmlProtocol,
} from "@ai-sdk-tool/parser";
import { type LanguageModel, wrapLanguageModel } from "ai";

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
  toolSystemPromptTemplate(tools: TCMToolDefinition[]) {
    const toolsString = JSON.stringify(tools);
    return systemPromptTemplate.replace(/\$\{tools\}/g, toolsString);
  },
});

// Friendli API
const friendli = createOpenAICompatible({
  name: "friendli.serverless",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

// Test models
const modelConfigs = [
  "MiniMaxAI/MiniMax-M2",
  "zai-org/GLM-4.6",
  "Qwen/Qwen3-30B-A3B",
];

const models: Record<string, LanguageModel> = {};

for (const modelId of modelConfigs) {
  try {
    const baseModel = friendli(modelId);
    const modelKey = modelId
      .split("/")[1]
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-");
    models[modelKey] = wrapLanguageModel({
      model: baseModel,
      middleware: customMorphXmlMiddleware,
    });
    console.log(`✓ Loaded model: ${modelId}`);
  } catch (e) {
    console.log(`✗ Failed to load model: ${modelId} - ${e}`);
  }
}

async function main() {
  console.log(
    `\nStarting evaluation with ${Object.keys(models).length} models\n`
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
    maxTokens: 256,
  });

  console.log("\nEvaluation complete!");
}

main();
