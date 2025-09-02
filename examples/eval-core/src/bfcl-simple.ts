import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  bfclMultipleBenchmark,
  bfclParallelBenchmark,
  bfclParallelMultipleBenchmark,
  bfclSimpleBenchmark,
  evaluate,
} from "@ai-sdk-tool/eval";
import {
  createToolMiddleware,
  gemmaToolMiddleware,
  morphXmlProtocol,
  xmlToolMiddleware,
} from "@ai-sdk-tool/parser";
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

const morphExp = wrapLanguageModel({
  model: friendli("meta-llama/Llama-3.3-70B-Instruct"),
  middleware: morphExpToolMiddleware,
});

const original = friendli("meta-llama/Llama-3.3-70B-Instruct");

async function main() {
  console.log("Starting model evaluation...");

  await evaluate({
    models: {
      // xml: xmlGemma27b,
      // json: jsonGemma27b,
      morphExp: morphExp,
      original: original,
    },
    benchmarks: [
      bfclSimpleBenchmark,
      bfclMultipleBenchmark,
      bfclParallelBenchmark,
      bfclParallelMultipleBenchmark,
    ],
    reporter: "console",
    temperature: 0.0,
    maxTokens: 4096,
  });

  console.log("Evaluation complete!");
}

main();
