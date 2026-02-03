import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { hermesToolMiddleware } from "@ai-sdk-tool/parser";
import {
  extractReasoningMiddleware,
  generateText,
  stepCountIs,
  wrapLanguageModel,
} from "ai";
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
      model: openrouter("arcee-ai/trinity-large-preview:free"),

      middleware: [
        // The order is important, extractReasoningMiddleware is called first and then hermesToolMiddleware,
        // because inside <think> the <tool_call> tag is created for reasoning and the tool call mode is triggered.
        hermesToolMiddleware,
        extractReasoningMiddleware({ tagName: "think" }),
      ],
    }),
    providerOptions: {
      openrouter: { reasoning: { enabled: true } },
    },
    system: "You are a helpful assistant.",
    prompt: "What is the weather in New York and Los Angeles?",
    stopWhen: stepCountIs(MAX_STEPS),
    tools: {
      get_weather: {
        description:
          "Get the weather for a given city. " +
          "Example cities: 'New York', 'Los Angeles', 'Paris'.",
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
