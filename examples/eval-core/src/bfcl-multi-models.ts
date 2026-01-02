import fs from "node:fs";
import path from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
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
  toolSystemPromptTemplate(tools: string) {
    return systemPromptTemplate.replace(/\$\{tools\}/g, tools);
  },
});

// Friendli API (Llama models)
const friendli = createOpenAICompatible({
  name: "friendli.serverless",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

// OpenAI
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Prepare models
const models: Record<string, LanguageModel> = {};

// Llama-4-Maverick (already tested)
if (process.env.FRIENDLI_TOKEN) {
  const llamaModel = friendli("meta-llama/Llama-4-Maverick-17B-128E-Instruct");
  models["llama-4-maverick-morph-xml"] = wrapLanguageModel({
    model: llamaModel,
    middleware: customMorphXmlMiddleware,
  });
}

// GPT-4o-mini
if (process.env.OPENAI_API_KEY) {
  const gpt4oMiniModel = openai("gpt-4o-mini");
  models["gpt-4o-mini-morph-xml"] = wrapLanguageModel({
    model: gpt4oMiniModel,
    middleware: customMorphXmlMiddleware,
  });
}

// GPT-4o
if (process.env.OPENAI_API_KEY) {
  const gpt4oModel = openai("gpt-4o");
  models["gpt-4o-morph-xml"] = wrapLanguageModel({
    model: gpt4oModel,
    middleware: customMorphXmlMiddleware,
  });
}

// Llama 3.1 70B (if available on Friendli)
if (process.env.FRIENDLI_TOKEN) {
  try {
    const llama31Model = friendli("meta-llama/Meta-Llama-3.1-70B-Instruct");
    models["llama-3.1-70b-morph-xml"] = wrapLanguageModel({
      model: llama31Model,
      middleware: customMorphXmlMiddleware,
    });
  } catch (_e) {
    console.log("Llama 3.1 70B not available");
  }
}

async function main() {
  console.log("Starting multi-model evaluation with custom system prompt...");
  console.log(`Testing ${Object.keys(models).length} models`);

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

  console.log("Evaluation complete!");
}

main();
