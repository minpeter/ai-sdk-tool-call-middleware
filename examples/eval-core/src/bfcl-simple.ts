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
  hermesToolMiddleware,
  morphXmlToolMiddleware,
} from "@ai-sdk-tool/parser";
import {
  sijawaraConsiseXmlToolMiddleware,
  sijawaraDetailedXmlToolMiddleware,
} from "@ai-sdk-tool/parser/community";
import { wrapLanguageModel } from "ai";

const friendli = createOpenAICompatible({
  name: "friendli.serverless",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

// const xmlGemma27b = wrapLanguageModel({
//   model: friendli("google/gemma-3-27b-it"),
//   // model: openrouter("z-ai/glm-4.5-air"),
//   middleware: xmlToolMiddleware,
// });

// const jsonGemma27b = wrapLanguageModel({
//   model: friendli("google/gemma-3-27b-it"),
//   // model: openrouter("z-ai/glm-4.5-air"),
//   middleware: gemmaToolMiddleware,
// });

// const morphXmlGemma27b = wrapLanguageModel({
//   model: friendli("google/gemma-3-27b-it"),
//   middleware: morphXmlToolMiddleware,
// });

// const compareDifferentMiddlewares = { xml: xmlGemma27b, morphXml: morphXmlGemma27b, json: jsonGemma27b };

const testTargetModel = friendli(
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct"
);
const hermes = wrapLanguageModel({
  model: testTargetModel,
  middleware: hermesToolMiddleware,
});

const morphXml = wrapLanguageModel({
  model: testTargetModel,
  middleware: morphXmlToolMiddleware,
});

const sijawaraDetailed = wrapLanguageModel({
  model: testTargetModel,
  middleware: sijawaraDetailedXmlToolMiddleware,
});

const sijawaraConsise = wrapLanguageModel({
  model: testTargetModel,
  middleware: sijawaraConsiseXmlToolMiddleware,
});

const compareWithNativeToolCalling = {
  hermes: hermes,
  morphXml: morphXml,
  sijawaraDetailed: sijawaraDetailed,
  sijawaraConsise: sijawaraConsise,
  original: testTargetModel,
};

async function main() {
  console.log("Starting model evaluation...");

  const reporterEnv = process.env.EVAL_REPORTER as ReporterType | undefined;

  await evaluate({
    models: compareWithNativeToolCalling,
    benchmarks: [
      bfclSimpleBenchmark,
      bfclMultipleBenchmark,
      bfclParallelBenchmark,
      bfclParallelMultipleBenchmark,
    ],
    reporter: reporterEnv ?? "console",
    temperature: 0.0,
    maxTokens: 512,
  });

  console.log("Evaluation complete!");
}

main();
