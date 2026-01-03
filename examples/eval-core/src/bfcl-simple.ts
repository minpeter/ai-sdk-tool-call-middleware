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
import { wrapLanguageModel } from "ai";

// Load system prompt from file
const systemPromptPath = path.join(
  __dirname,
  "Llama-4-Maverick-morphXml-bfcl.txt"
);
const systemPromptTemplate = fs.readFileSync(systemPromptPath, "utf-8");

const friendli = createOpenAICompatible({
  name: "friendli.serverless",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

const testTargetModel = friendli(
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct"
);

// Create custom middleware with loaded system prompt
const customMorphXmlMiddleware = createToolMiddleware({
  protocol: xmlProtocol,
  placement: "last",
  toolSystemPromptTemplate(tools) {
    const toolsString = JSON.stringify(tools);
    return systemPromptTemplate.replace(/\$\{tools\}/g, toolsString);
  },
});

const morphXmlModel = wrapLanguageModel({
  model: testTargetModel,
  middleware: customMorphXmlMiddleware,
});

async function main() {
  console.log("Starting model evaluation with custom system prompt...");

  const reporterEnv = process.env.EVAL_REPORTER as ReporterType | undefined;

  await evaluate({
    models: {
      "llama-4-maverick-morph-xml": morphXmlModel,
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
    cache: {
      cacheDir: ".benchmark-results/cache",
    },
  });

  console.log("Evaluation complete!");
}

main();
