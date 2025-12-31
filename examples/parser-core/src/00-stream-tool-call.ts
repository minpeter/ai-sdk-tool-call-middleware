import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { morphXmlToolMiddleware } from "@ai-sdk-tool/parser";
import { stepCountIs, streamText, wrapLanguageModel } from "ai";
import { z } from "zod";

// Constants
const MAX_STEPS = 4;
const MAX_TEMPERATURE = 100;

// const openrouter = createOpenAICompatible({
//   name: "openrouter",
//   apiKey: process.env.OPENROUTER_API_KEY,
//   baseURL: "https://openrouter.ai/api/v1",
// });

const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
  includeUsage: true,
  fetch: async (url, options) =>
    await fetch(url, {
      ...options,
      body: JSON.stringify({
        ...(options?.body ? JSON.parse(options.body as string) : {}),
        parse_reasoning: true,
      }),
    }),
});

async function main() {
  const result = streamText({
    model: wrapLanguageModel({
      model: friendli("zai-org/GLM-4.6"),
      middleware: morphXmlToolMiddleware,
    }),

    // model: wrapLanguageModel({
    //   model: openrouter("google/gemma-3-27b-it"),
    //   middleware: gemmaToolMiddleware,
    // }),

    temperature: 0.0,
    system: "You are a helpful assistant.",
    prompt: "What is the weather in my city?",
    stopWhen: stepCountIs(MAX_STEPS),
    tools: {
      get_location: {
        description: "Get the User's location.",
        inputSchema: z.object({}),
        execute: () => {
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
  });

  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      process.stdout.write(part.text);
    } else if (part.type === "reasoning-delta") {
      // Print reasoning text in a different color (e.g., yellow)
      process.stdout.write(`\x1b[33m${part.text}\x1b[0m`);
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
