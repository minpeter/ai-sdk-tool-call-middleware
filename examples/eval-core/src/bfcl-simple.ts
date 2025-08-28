import {
  evaluate,
  bfclSimpleBenchmark,
  bfclMultipleBenchmark,
  bfclParallelBenchmark,
  bfclParallelMultipleBenchmark,
} from "@ai-sdk-tool/eval";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import {
  gemmaToolMiddleware,
  xmlToolMiddleware,
  morphExpToolMiddleware,
} from "@ai-sdk-tool/parser";
import { openai } from "@ai-sdk/openai";

const friendli = createOpenAICompatible({
  name: "friendli.serverless",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

const openrouter = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

const xmlGemma27b = wrapLanguageModel({
  model: friendli("google/gemma-3-27b-it"),
  // model: openrouter("z-ai/glm-4.5-air"),
  middleware: xmlToolMiddleware,
});

const jsonGemma27b = wrapLanguageModel({
  model: friendli("google/gemma-3-27b-it"),
  // model: openrouter("z-ai/glm-4.5-air"),
  middleware: gemmaToolMiddleware,
});

const morphExpGemma27b = wrapLanguageModel({
  model: friendli("google/gemma-3-27b-it"),
  // model: openrouter("z-ai/glm-4.5-air"),
  middleware: morphExpToolMiddleware,
});

const gpt41nano = openai("gpt-4.1-nano");

async function main() {
  console.log("Starting model evaluation...");

  await evaluate({
    models: [
      // gpt41nano,
      xmlGemma27b,
      morphExpGemma27b,
      jsonGemma27b,
    ],
    benchmarks: [
      // bfclSimpleBenchmark,
      bfclMultipleBenchmark,
      // bfclParallelBenchmark,
      // bfclParallelMultipleBenchmark,
    ],
    reporter: "console.debug",
  });

  console.log("Evaluation complete!");
}

main();
