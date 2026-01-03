import { openai } from "@ai-sdk/openai";
import {
  evaluate,
  jsonGenerationBenchmark,
  jsonGenerationSchemaOnlyBenchmark,
} from "@ai-sdk-tool/eval";
import { wrapLanguageModel } from "ai";

const gpt41nano = wrapLanguageModel({
  model: openai("gpt-4.1-nano"),
  middleware: [],
});

async function main() {
  console.log("Starting JSON generation benchmark...");

  await evaluate({
    models: [gpt41nano],
    benchmarks: [jsonGenerationSchemaOnlyBenchmark, jsonGenerationBenchmark],
    reporter: "console",
  });

  console.log("JSON generation benchmark complete!");
}

main();
