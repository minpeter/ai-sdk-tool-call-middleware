import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText, wrapLanguageModel } from "ai";
import { z } from "zod";
import { hermesToolMiddleware } from "./hermes-middleware";

const openrouter = createOpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

async function main() {
  const {} = await generateText({
    model: wrapLanguageModel({
      // model: openrouter("google/gemma-3-27b-it"),
      model: openrouter("nousresearch/hermes-3-llama-3.1-70b"),
      middleware: hermesToolMiddleware,
    }),
    system: "You are a helpful assistant.",
    prompt: "What is the weather in New York and Los Angeles?",
    maxSteps: 10,
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
    onStepFinish: async ({ stepType, toolResults, text }) => {
      console.log({
        stepType,
        text,
        toolResults,
      });
    },
  });
}

main().catch(console.error);
