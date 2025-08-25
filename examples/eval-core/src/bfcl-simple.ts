import { evaluate, bfclSimpleBenchmark } from "@ai-sdk-tool/eval";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import { gemmaToolMiddleware } from "@ai-sdk-tool/parser";
import { openai } from "@ai-sdk/openai";

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
  console.log("Starting model evaluation...");

  await evaluate({
    models: [gpt41nano, gemma27b],
    benchmarks: [bfclSimpleBenchmark],
    reporter: "console",
  });

  console.log("Evaluation complete!");
}

main();
