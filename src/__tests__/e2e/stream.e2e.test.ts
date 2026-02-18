import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  extractReasoningMiddleware,
  type LanguageModel,
  stepCountIs,
  streamText,
  wrapLanguageModel,
} from "ai";
import { z } from "zod";
import { hermesToolMiddleware, morphXmlToolMiddleware } from "../../index";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

const friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

const testModels = {
  hermes: wrapLanguageModel({
    model: openrouter("nousresearch/hermes-4-405b"),
    middleware: hermesToolMiddleware,
  }),
  xml: wrapLanguageModel({
    model: openrouter("z-ai/glm-4.5-air"),
    middleware: morphXmlToolMiddleware,
  }),
  reasoning: wrapLanguageModel({
    model: friendli("deepseek-ai/DeepSeek-R1-0528"),
    middleware: [
      hermesToolMiddleware,
      extractReasoningMiddleware({ tagName: "think" }),
    ],
  }),
};

async function main() {
  for (const model of Object.values(testModels)) {
    console.log(`\n\nTesting ${model.modelId}...`);
    await streamE2E(model);
  }
}

const MAX_STEPS = 4;
const MAX_TEMPERATURE = 100;

async function streamE2E(model: LanguageModel) {
  const result = streamText({
    model,
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
