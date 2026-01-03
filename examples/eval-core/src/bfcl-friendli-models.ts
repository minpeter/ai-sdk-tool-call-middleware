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

// Prepare models - various Friendli models
const modelConfigs = [
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct",
  "meta-llama/Meta-Llama-3.1-8B-Instruct",
  "meta-llama/Meta-Llama-3.1-70B-Instruct",
  "meta-llama/Meta-Llama-3.3-70B-Instruct",
  "mistralai/Mixtral-8x7B-Instruct-v0.1",
  "Qwen/Qwen2.5-72B-Instruct",
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
    `\nStarting multi-model evaluation with ${Object.keys(models).length} models\n`
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
    cache: {
      cacheDir: ".benchmark-results/cache",
    },
  });

  console.log("\nEvaluation complete!");
}

main();
