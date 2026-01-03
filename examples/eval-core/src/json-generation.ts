import { openai } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  evaluate,
  jsonGenerationBenchmark,
  jsonGenerationSchemaOnlyBenchmark,
} from "@ai-sdk-tool/eval";
import { wrapLanguageModel } from "ai";

const gemma27b = wrapLanguageModel({
  model: createOpenAICompatible({
    name: "openrouter",
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
  })("google/gemma-3-27b-it"),
  middleware: [],
});

const gpt41nano = wrapLanguageModel({
  model: openai("gpt-4.1-nano"),
  middleware: [],
});

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
