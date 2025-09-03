import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  bfclMultipleBenchmark,
  bfclParallelBenchmark,
  bfclParallelMultipleBenchmark,
  bfclSimpleBenchmark,
  evaluate,
  type ReporterType,
} from "@ai-sdk-tool/eval";
import { createToolMiddleware, morphXmlProtocol } from "@ai-sdk-tool/parser";
import { wrapLanguageModel } from "ai";

const friendli = createOpenAICompatible({
  name: "friendli.serverless",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

const morphExpToolMiddleware = createToolMiddleware({
  protocol: morphXmlProtocol,
  toolSystemPromptTemplate(tools: string) {
    return `You are a function calling AI model.

Available functions are listed inside <tools></tools>.
<tools>${tools}</tools>

# Rules
- Use exactly one XML element whose tag name is the function name.
- Put each parameter as a child element.
- Values must follow the schema exactly (numbers, arrays, objects, enums → copy as-is).
- Do not add or remove functions or parameters.
- Each required parameter must appear once.
- Output nothing before or after the function call.

# Example
<get_weather>
  <location>New York</location>
  <unit>celsius</unit>
</get_weather>`;
  },
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

// const morphExpGemma27b = wrapLanguageModel({
//   model: friendli("google/gemma-3-27b-it"),
//   middleware: morphExpToolMiddleware,
// });

// const compareDifferentMiddlewares = { xml: xmlGemma27b, morphExp: morphExpGemma27b, json: jsonGemma27b };

const morphExp = wrapLanguageModel({
  model: friendli("LGAI-EXAONE/EXAONE-4.0.1-32B"),
  middleware: morphExpToolMiddleware,
});

const original = friendli("LGAI-EXAONE/EXAONE-4.0.1-32B");

const compareWithNativeToolCalling = {
  morphExp: morphExp,
  original: original,
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
