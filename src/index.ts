import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, streamText, wrapLanguageModel } from "ai";
import { z } from "zod";
import { hermesToolMiddleware } from "./hermes-middleware";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

async function main() {
  const result = streamText({
    // model: openrouter("openai/gpt-4o"),
    model: wrapLanguageModel({
      model: openrouter("google/gemma-3-27b-it"),
      // model: openrouter("nousresearch/hermes-3-llama-3.1-70b"),
      middleware: hermesToolMiddleware({
        tagName: "tool_call",
      }),
    }),
    system: "You are a helpful assistant.",
    prompt: "What is the weather in New York and Los Angeles?",
    maxSteps: 1,
    tools: {
      get_weather: {
        description:
          "Get the weather for a given city. " +
          "Example cities: 'New York', 'Los Angeles', 'Paris'.",
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => {
          // Simulate a weather API call
          const temperature = Math.floor(Math.random() * 100);
          return {
            city,
            temperature,
            condition: "sunny",
          };
        },
      },
    },
  });

  for await (const part of result.fullStream) {
    console.log(part);
  }
}

main().catch(console.error);
