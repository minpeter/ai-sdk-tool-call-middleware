import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  generateText,
  type LanguageModel,
  stepCountIs,
  wrapLanguageModel,
} from "ai";
import { z } from "zod";
import { hermesToolMiddleware, xmlToolMiddleware } from "../../index";

const openrouter = createOpenAICompatible({
  name: "openrouter",
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

const _friendli = createOpenAICompatible({
  name: "friendli",
  apiKey: process.env.FRIENDLI_TOKEN,
  baseURL: "https://api.friendli.ai/serverless/v1",
});

const MAX_STEPS = 4;
const MAX_TEMPERATURE = 100;

const testModels = {
  gemma: wrapLanguageModel({
    model: openrouter("google/gemma-3-27b-it"),
    middleware: xmlToolMiddleware,
  }),
  hermes: wrapLanguageModel({
    model: openrouter("nousresearch/hermes-4-405b"),
    middleware: hermesToolMiddleware,
  }),
  xml: wrapLanguageModel({
    model: openrouter("z-ai/glm-4.5-air"),
    middleware: xmlToolMiddleware,
  }),
};

async function main() {
  for (const model of Object.values(testModels)) {
    console.log(`\n\nTesting ${model.modelId}...`);
    await generateE2E(model);
  }
}

async function generateE2E(model: LanguageModel) {
  await generateText({
    model,
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
      console.log({
        text: step.text,
        reasoning: step.reasoning,
        toolCalls: step.toolCalls.map(
          (call) =>
            `name: ${call.toolName}, input: ${JSON.stringify(call.input)}`
        ),
        toolResults: step.toolResults.map((result) =>
          JSON.stringify(result.output)
        ),
      });
    },
  });
}

main().catch(console.error);
