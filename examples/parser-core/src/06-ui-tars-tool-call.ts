import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { uiTarsToolMiddleware } from "@ai-sdk-tool/parser/community";
import { generateText, stepCountIs, wrapLanguageModel } from "ai";
import { z } from "zod";
import { printComplete, printStepLikeStream } from "./console-output";

// Constants
const MAX_STEPS = 4;
const MAX_TEMPERATURE = 100;

const openrouter = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

async function main() {
  await generateText({
    model: wrapLanguageModel({
      model: openrouter("z-ai/glm-4.5-air"),
      middleware: uiTarsToolMiddleware,
    }),
    system: "You are a helpful assistant.",
    prompt: "What is the weather in New York?",
    stopWhen: stepCountIs(MAX_STEPS),
    tools: {
      get_weather: {
        description: "Get the weather for a given city.",
        inputSchema: z.object({ city: z.string() }),
        execute: ({ city }) => {
          // Simulate a weather API call
          const temperature = Math.floor(Math.random() * MAX_TEMPERATURE);
          return {
            city,
            temperature,
            condition: "sunny",
          };
        },
      },
    },
    onStepFinish: (step) => {
      printStepLikeStream(step);
    },
  });

  printComplete();
}

main().catch(console.error);
