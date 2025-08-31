import { openai } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  evaluate,
  jsonGenerationBenchmark,
  jsonGenerationSchemaOnlyBenchmark,
} from "@ai-sdk-tool/eval";
import { gemmaToolMiddleware } from "@ai-sdk-tool/parser";
import { wrapLanguageModel } from "ai";

const gemma27b = wrapLanguageModel({
  model: createOpenAICompatible({
    name: "openrouter",
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
  })("google/gemma-3-27b-it"),
  middleware: gemmaToolMiddleware,
});

const gpt41nano = openai("gpt-4.1-nano");

async function main() {
  console.log("Starting JSON generation benchmark...");

  await evaluate({
    models: [gpt41nano, gemma27b],
    benchmarks: [jsonGenerationSchemaOnlyBenchmark, jsonGenerationBenchmark],
    reporter: "console",
  });

  console.log("JSON generation benchmark complete!");
}

main();
