import { gemmaToolMiddleware } from "@ai-sdk-tool/parser";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, wrapLanguageModel } from "ai";
import { z } from "zod";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

async function main() {
  const result = streamText({
    // model: wrapLanguageModel({
    //   model: openrouter("z-ai/glm-4.5-air"),
    //   middleware: xmlToolMiddleware,
    // }),

    model: wrapLanguageModel({
      model: openrouter("google/gemma-3-27b-it"),
      middleware: gemmaToolMiddleware,
    }),

    temperature: 0.0,
    system: "You are a helpful assistant.",
    prompt: "What is the weather in my city?",
    stopWhen: stepCountIs(4),
    tools: {
      get_location: {
        description: "Get the User's location.",
        inputSchema: z.object({}),
        execute: async () => {
          // Simulate a location API call
          return {
            city: "New York",
            country: "USA",
          };
        },
      },
      get_weather: {
        description:
          "Get the weather for a given city. " +
          "Example cities: 'New York', 'Los Angeles', 'Paris'.",
        inputSchema: z.object({ city: z.string() }),
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
    if (part.type === "text-delta") {
      process.stdout.write(part.text);
    } else if (part.type === "tool-result") {
      console.log({
        name: part.toolName,
        input: part.input,
        output: part.output,
      });
    }
  }

  console.log("\n\n<Complete>");
}

main().catch(console.error);
